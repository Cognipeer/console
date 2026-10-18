/**
 * Rendering a prompt template into the text a model reads.
 *
 * Mustache writes the value of every `{{name}}` tag through an HTML escaper
 * (`&` becomes `&amp;`, `<` becomes `&lt;`, quotes, `/`, `` ` `` and `=` become
 * entities). That is right for a web page and wrong for a prompt: a customer
 * called `Tom & Jerry` reaches the model as `Tom &amp; Jerry`, and a code or
 * URL variable arrives mangled. Prompt text is not HTML, so the escaping is
 * switched off for the render, with the per-call `escape` option rather than
 * the library's global `Mustache.escape`, which would change every other
 * render in the process.
 *
 * Everything that turns a template into model-facing text goes through here
 * (the agent's system prompt, the prompt library's render, the dashboard's
 * preview of both). `{{x}}`, `{{{x}}}` and `{{&x}}` now insert the same text;
 * sections, inverted sections and comments are untouched. A value that is an
 * object still prints as `[object Object]`, exactly as before.
 *
 * Free of React, Next and Node APIs: the browser and the server render alike.
 */

import Mustache from 'mustache';

/** The escaper of a prompt render: the value as text, nothing replaced. */
const verbatim = (value: unknown): string => String(value);

/** Renders `template` over `view` with every inserted value written as it is. */
export function renderPromptText(template: string, view: unknown): string {
  return Mustache.render(template, view, undefined, { escape: verbatim });
}
