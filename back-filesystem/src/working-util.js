/*
 * Copyright © 2018, Octave Online LLC
 *
 * This file is part of Octave Online Server.
 *
 * Octave Online Server is free software: you can redistribute it and/or
 * modify it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the License,
 * or (at your option) any later version.
 *
 * Octave Online Server is distributed in the hope that it will be useful, but
 * WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
 * or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU Affero General Public
 * License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with Octave Online Server.  If not, see
 * <https://www.gnu.org/licenses/>.
 */

"use strict";

const async = require("async");
const fs = require("fs");
const path = require("path");
const mime = require("mime");
const charsetDetector = require("charset-detector");
const Iconv = require("iconv").Iconv;
const logger = require("@oo/shared").logger;
const config = require("@oo/shared").config;
const crypto = require("crypto");

// Load extra MIME types
mime.load(path.join(__dirname, "mime.types"));

const ACCEPTABLE_MIME_REGEX = /^(text\/.*)$/;
const UNACCEPTABLE_FILENAME_REGEX = /^(\..*|octave-\w+)$/;

class WorkingUtil {
	constructor(workDir, logMemo) {
		this._log = logger(`working-util:${logMemo}`);
		this._mlog = logger(`working-util:${logMemo}:minor`);
		this.cwd = workDir;
	}

	listAll(next) {
		async.waterfall([
			(_next) => {
				this._recursiveReaddir(this.cwd, 0, _next);
			},
			(fileInfos, _next) => {
				const dict = {};
				fileInfos.forEach((fileInfo) => {
					if (!fileInfo) return;
					let filename = fileInfo.filename;
					delete fileInfo.filename;
					dict[filename] = fileInfo;
				});
				_next(null, dict);
			}
		], next);
	}

	hasOctaverc(next) {
		fs.access(path.join(this.cwd, ".octaverc"), (err) => {
			if (err) {
				this._mlog.trace(".octaverc does not exist");
				return next(null, false);
			} else {
				this._mlog.trace(".octaverc exists");
				return next(null, true);
			}
		});
	}

	_recursiveReaddir(directory, depth, next) {
		// Don't recurse more than 3 levels deep
		if (depth > 3) {
			return next(null, []);
		}

		async.waterfall([
			(_next) => {
				this._mlog.trace("Entering directory", directory);
				fs.readdir(directory, _next);
			},
			(files, _next) => {
				async.map(files, (filename, __next) => {
					let pathname = path.join(directory, filename);
					let relname = path.relative(this.cwd, pathname);
					// TODO: Can the following be removed?
					if (pathname === path.join(this.cwd, ".git")) {
						this._mlog.debug("Skipping .git in _recursiveReaddir");
						return;
					}
					async.waterfall([
						(___next) => {
							// lstat to prevent following symlinks
							fs.lstat(pathname, ___next);
						},
						(stats, ___next) => {
							this._mlog.trace("Got lstats", relname, stats.isDirectory(), stats.isFile());
							if (stats.isDirectory()) {
								return this._recursiveReaddir(pathname, depth+1, ___next);
							} else if (stats.isFile()) {
								return this._getFileInfo(filename, pathname, relname, stats, ___next);
							} else {
								return ___next(null, []);
							}
						}
					], __next);
				}, (err, results) => {
					if (err) return _next(err);
					this._mlog.trace("Leaving directory", directory);
					_next(null, Array.prototype.concat.apply([], results));
				});
			}
		], next);
	}

	// Endpoint for standalone getFileInfo (used by SIOFU)
	getFileInfo(filename, next) {
		let pathname = this._safePath(filename);
		let relname = path.relative(this.cwd, pathname);
		async.waterfall([
			(_next) => {
				fs.lstat(pathname, _next);
			},
			(stats, _next) => {
				this._getFileInfo(filename, pathname, relname, stats, _next);
			},
			(arr, _next) => {
				_next(null, arr[0]);
			}
		], next);
	}

	_getFileInfo(filename, pathname, relname, stats, next) {
		this._mlog.trace("Getting file info for", relname);
		let _mime = mime.lookup(filename);
		if (ACCEPTABLE_MIME_REGEX.test(_mime)) {
			if (stats.size > config.session.textFileSizeLimit) {
				// This file is too big.  Do not perform any further processing on this file.
				// FIXME: Show a nice message to the end user to let them know why their file isn't being loaded
				this._log.debug("Skipping text file that is too big:", stats.size, filename);
				next(null, [{
					filename: relname,
					isText: false
				}]);
			} else {
				fs.readFile(pathname, (err, buf) => {
					if (err) return next(err);
					buf = this._convertCharset(buf);
					next(null, [{
						filename: relname,
						isText: true,
						content: buf.toString("base64")
					}]);
				});
			}
		} else if (!UNACCEPTABLE_FILENAME_REGEX.test(filename)) {
			next(null, [{
				filename: relname,
				isText: false
			}]);
		} else {
			next(null, []);
		}
	}

	_convertCharset(buf) {
		var encoding;

		// Detect and attempt to convert charset
		if (buf.length > 0) {
			try {
				let charsetResults = charsetDetector(buf);
				this._log.debug("Top charset match:", charsetResults?.[0]);
				encoding = charsetResults?.[0]?.charsetName || "UTF-8";
				if (encoding !== "UTF-8"){
					this._log.trace("Converting charset:", encoding);
					buf = new Iconv(encoding, "UTF-8").convert(buf);
				}
			} catch(err) {
				this._log.warn("Could not convert encoding:", encoding);
			}
		}

		// Convert line endings
		// TODO: Is there a better way than converting to a string here?
		buf = new Buffer(buf.toString("utf8").replace(/\r\n/g, "\n"));

		return buf;
	}

	saveFile(filename, value, next) {
		// Create backup of file in memory in case there are any I/O errors
		async.waterfall([
			(_next) => {
				let dirname = path.dirname(this._safePath(filename));
				// Callback to a function to remove/normalize extra arguments
				fs.mkdir(dirname, { recursive: true }, (e) => _next(e));
			},
			(_next) => {
				fs.readFile(
					this._safePath(filename),
					(err, buf) => {
						if (!err) return _next(null, buf);
						if (/ENOENT/.test(err.message)) {
							this._log.info("Creating new file:", filename);
							return _next(null, new Buffer(0));
						}
						return _next(err);
					}
				);
			},
			(buf, _next) => {
				fs.writeFile(
					this._safePath(filename),
					value,
					(err) => {
						_next(null, buf, err);
					});
			},
			(buf, err, _next) => {
				if (err) {
					fs.writeFile(
						this._safePath(filename),
						buf,
						() => {
							_next(err);
						});
				} else {
					async.nextTick(() => {
						_next(null);
					});
				}
			},
			(_next) => {
				return _next(null, crypto.createHash("md5").update(value, "utf-8").digest("hex"));
			}
		], next);
	}

	renameFile(oldname, newname, next) {
		fs.rename(
			this._safePath(oldname),
			this._safePath(newname),
			next);
	}

	deleteFile(filename, next) {
		fs.unlink(
			this._safePath(filename),
			next);
	}

	readBinary(filename, next) {
		async.waterfall([
			(_next) => {
				fs.readFile(this._safePath(filename), _next);
			},
			(buf, _next) => {
				const base64data = buf.toString("base64");
				const _mime = mime.lookup(filename);
				_next(null, base64data, _mime);
			}
		], next);
	}

	_safePath(filename) {
		// Filenames must descend from the working directory.  Forbids filenames starting with '..' or similar.
		let candidate = path.join(this.cwd, filename);
		if (candidate.substring(0, this.cwd.length) !== this.cwd) {
			this._log.warn("Processed a fishy filename:", filename);
			return path.join(this.cwd, "octave-workspace"); // an arbitrary legal path
		}
		return candidate;
	}
}

module.exports = WorkingUtil;
