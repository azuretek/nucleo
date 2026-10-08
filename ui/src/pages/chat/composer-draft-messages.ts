// Draft-persistence messages, and the mapping from a storage reason to the message shown.
//
// Extracted from composer-persistence.ts, which is a grandfathered file over its line cap. The ratchet
// allows such a file only to shrink and says to extract a coherent sibling module rather than to trim
// coverage, so new prose and its mapping live here and that file gets smaller rather than larger.

export const CHAT_COMPOSER_DRAFT_SIZE_ERROR =
  "These attachments exceed the draft storage limit. They remain available in this tab; remove attachments before reloading to save this draft.";

export const CHAT_COMPOSER_DRAFT_STORAGE_ERROR =
  "Could not store the previous draft in browser storage. It remains available in this tab.";

export function chatComposerDraftErrorMessage(reason: string | undefined): string {
  return reason === "payload-too-large"
    ? CHAT_COMPOSER_DRAFT_SIZE_ERROR
    : CHAT_COMPOSER_DRAFT_STORAGE_ERROR;
}
