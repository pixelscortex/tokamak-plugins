/**
 * How a turn's failure reason starts when `code` could not save the code before
 * it: the agent never ran. The window reads it to tell such a turn from one that
 * ran without Git.
 */
export const BEFORE_NOT_SAVED = "Couldn't save the code before this turn";
