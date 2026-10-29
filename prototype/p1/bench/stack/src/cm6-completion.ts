/** Completion source backed by a document profile (schema sample), not runtime reflection. */
import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';

const arrayMethods = ['filter', 'find', 'map', 'reduce', 'some', 'every', 'slice', 'length', 'flat'];
const objectFields = ['hotel_id', 'hotel_name', 'price', 'available', 'eta', 'hotel_tags', 'review_count'];

export function jsonExprCompletion(context: CompletionContext): CompletionResult | null {
  // member access: `<something>.` → object fields / array methods
  const member = /(?:^|[^.\w$])([\w$]+)\.\w*$/.exec(context.state.sliceDoc(Math.max(0, context.pos - 80), context.pos));
  if (member) {
    const base = member[1];
    const options = (base === 'hotel_tags' ? arrayMethods : objectFields).map((label) => ({
      label,
      type: 'property',
    }));
    const word = context.matchBefore(/[\w$]*/);
    return { from: word ? word.from : context.pos, options, validFor: /^[\w$]*$/ };
  }
  // top-level fields + the root variable
  const word = context.matchBefore(/[\w$]*/);
  if (!word) return null;
  if (word.from === word.to && !context.explicit) return null;
  const options = ['$', ...objectFields, 'data', 'status'].map((label) => ({ label, type: 'variable' }));
  return { from: word.from, options, validFor: /^[\w$]*$/ };
}

export const completionSource: CompletionSource = jsonExprCompletion;
