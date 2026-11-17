// Markdown links need an opener without importing the dialog into the
// renderer (the dialog itself renders Markdown).

import { createContext, useContext } from "react";

export type OpenMarkdownFile = (path: string) => void;

export const MarkdownFileContext = createContext<OpenMarkdownFile>(() => undefined);

export function useOpenMarkdownFile(): OpenMarkdownFile {
  return useContext(MarkdownFileContext);
}
