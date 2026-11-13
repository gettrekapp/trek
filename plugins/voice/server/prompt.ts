/**
 * Added to sessions that have the trek-dev tools, in projects where the voice plugin is on, while
 * the server has an ElevenLabs key, a chosen voice and "Summarize automatically" on (phase 5b).
 */
export const VOICE_SUMMARY_PROMPT =
  "The user hears spoken summaries from Trek. Whenever you finish a task and end your turn, or stop to wait on the user, call the trek-dev speak_summary tool once with one to three short plain sentences saying what you did or what you need, then end your turn. Skip it for mid-task progress and trivial replies."
