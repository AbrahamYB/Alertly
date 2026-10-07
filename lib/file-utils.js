import fs from "node:fs";

const REPLACE_ERRORS = new Set(["EACCES", "EEXIST", "EPERM"]);

/**
 * Replace a file after writing a sibling temporary file.
 *
 * POSIX uses an atomic rename. Windows can temporarily reject replacement
 * renames while antivirus/indexing software has the destination open, so we
 * retry briefly before using copy-and-unlink as a last-resort compatibility
 * path. The fallback only runs for the Windows replacement error codes.
 */
export function replaceFileSync(source, destination, { retries = 4 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      fs.renameSync(source, destination);
      return;
    } catch (error) {
      lastError = error;
      if (process.platform !== "win32" || !REPLACE_ERRORS.has(error?.code)) throw error;
    }
  }

  try {
    fs.copyFileSync(source, destination);
    fs.unlinkSync(source);
  } catch (error) {
    error.cause = lastError;
    throw error;
  }
}
