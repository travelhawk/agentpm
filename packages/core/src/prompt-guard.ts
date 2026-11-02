import type { PromptApi } from '@agentpm/shared';

type PromptMethod = 'selectOne' | 'selectMany' | 'confirm' | 'input';

/**
 * True when the prompt can actually be shown. The CLI always passes every
 * prompt function, even without a TTY, and calling one then fails with a bare
 * "requires a TTY". Callers check this first, so they can show an error that
 * names the flags that answer the question instead.
 */
export function canPrompt<K extends PromptMethod>(
  prompts: PromptApi,
  method: K,
): prompts is PromptApi & Required<Pick<PromptApi, K>> {
  return (
    typeof prompts[method] === 'function' && prompts.isInteractive?.() !== false
  );
}
