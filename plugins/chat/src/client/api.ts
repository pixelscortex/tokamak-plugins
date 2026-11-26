/**
 * Chat's window entry. Other plugins extend these components through
 * `plugin:chat/client`, e.g. `after(chat.find("box"), AgentRow)`, and learn
 * about each Send with `onSent`, and can turn Send off with `holdSend`.
 */
export { Chat } from "./pages/chat";
export { Composer, type ComposerProps } from "./ui/composer";
export { Empty, type EmptyProps } from "./ui/empty";
export { Header, type HeaderProps } from "./ui/thread-header";
export { Message, messageText, type MessageProps } from "./ui/message";
export { ThreadRow, type ThreadRowProps } from "./ui/thread-list";
export { onDraftSubmit, onSent, type DraftIntent, type DraftSubmission, type Sent } from "./lib/sent";
export { resolveFolder } from "./lib/send";
export { holdSend, type Hold } from "./lib/hold";
export type { Folder, MessageDoc, Thread } from "./lib/api";
