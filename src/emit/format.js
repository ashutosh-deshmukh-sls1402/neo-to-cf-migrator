/**
 * Prettier over the finished JavaScript.
 *
 * Everything upstream of here splices: the AST only locates, the original text
 * is edited by offset, and every comment, blank line and indentation choice the
 * NEO file made survives. That is deliberate — it is what lets a converted file
 * be diffed against the file it came from. It also means the output inherits
 * NEO's formatting, tabs and all, plus the seams where a statement was deleted
 * out of the middle of a block.
 *
 * So this runs last, after every offset-based pass has had its say, and only
 * over `.js`. Nothing here decides anything: if Prettier cannot parse a file,
 * the file is kept exactly as it was and said so — a parse failure at this
 * point is a bug in an earlier pass, not something to paper over by reformatting
 * what did survive.
 *
 * `--no-format` turns it off, for when a line-by-line diff against the NEO
 * original matters more than the file reading like modern JavaScript.
 */

import { format } from 'prettier';

/** What the emitted tree is written for: CAP on Node, ES modules. */
const OPTIONS = { parser: 'babel', printWidth: 100 };

/**
 * Format every `.js` file in place.
 *
 * @param {{path:string, text:string}[]} files  as `convert` returns them
 * @returns {Promise<{formatted:number, failed:{file:string, message:string}[]}>}
 */
export async function formatJs(files) {
  const failed = [];
  let formatted = 0;

  for (const f of files) {
    if (!f.path.endsWith('.js')) continue;
    try {
      const text = await format(f.text, { ...OPTIONS, filepath: f.path });
      if (text !== f.text) formatted++;
      f.text = text;
    } catch (err) {
      failed.push({ file: f.path, message: String(err.message).split('\n')[0] });
    }
  }

  return { formatted, failed };
}
