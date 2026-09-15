/**
 * Asking where the grammars are — once, and only when the answer is needed.
 *
 * A packaged copy has no `grammars` beside it and inherits no environment, so it has
 * to be told. The question is awkward to place: the browser picks grammars through a
 * handle that never reveals a path, and `create-parser` takes a path and nothing else,
 * so the two halves need a folder in common and only the operating system can name it.
 *
 * Nothing here opens by itself. A dialog in front of a blank screen, about a folder,
 * before anything has happened is a bad way to start; so is one that interrupts a
 * sentence being typed. The page says what it is missing and offers the question, and
 * the person decides when to answer it — including never, since everything except the
 * sentence bar's XLE check works without it.
 */

import { saveRoots } from './grammars.mjs';
import { chooseFolder } from './platform.mjs';

const PROMPT =
  'Where are your XLE grammars? Pick the folder that holds them - subfolders are ' +
  'searched too. This is only needed to check sentences against the morphology.';

/** Put the folder chooser on screen, returning what was picked. */
export const askForFolder = () => chooseFolder(PROMPT);

/** Ask, and remember the answer. Returns the roots now in force. */
export function chooseGrammarRoots({ choose = askForFolder, save = saveRoots, env = process.env } = {}) {
  const picked = choose();
  if (!picked) return undefined;
  save([picked], env);
  return picked;
}
