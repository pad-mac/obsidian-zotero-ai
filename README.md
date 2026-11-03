# Zotero AI

An Obsidian chat pane for asking Claude about the PDFs and books in your
Zotero library. It works alongside **ZotFlow Evo** (`pad-mac/zotflow-evo`):
it reads ZotFlow's database for the items and your annotations, and finds the
files on this computer by itself. Claude Desktop does not need to run. You
need an Anthropic API key, which is billed per use and separately from a
Claude subscription.

Desktop only, because it reads files from Zotero's folders.

## Use

- **Open chat** (ribbon ✦ or command). An empty chat attaches whatever you
  are reading: a PDF in ZotFlow's reader, a ZotFlow source note
  (`zotero-key` + `library-id` in its frontmatter), or a PDF in the vault.
- **Ask about the current item** (command) attaches it to the chat.
- **Add from Zotero**: search the library (author, year, title, citekey).
  You can attach several documents to compare them.
- Per document:
  - **Text / PDF**: *Text* sends the extracted text (cheap). *PDF* sends the
    file itself, so Claude also sees figures, tables and scans. Each page then
    also costs image tokens.
  - **Pages**: e.g. `12–40, 55`, using printed page labels (roman numerals
    work), else positions. Use it to keep book chapters affordable.
  - Your Zotero highlights and comments are sent along (setting).
- Claude cites pages as `[p. 12]`. They become links that open ZotFlow's
  reader at that page, in the pane and in saved notes.
- **Save chat as note** writes the chat into the chat folder. The
  frontmatter links the sources' `@citekey` notes.
- Documents are marked for prompt caching, so follow-up questions within a few
  minutes are much cheaper. Each answer shows its tokens (in, cached, out) on
  hover.

## Where the text comes from

1. The file's bytes. The plugin tries these in order:
   - Zotero's storage folder (`<data>/storage/<key>/<file>`)
   - linked files (also `attachments:` paths, via ZotFlow's base folder)
   - a group's shared folder on this computer (ZotFlow Evo's group folders,
     e.g. HU-Box)
   - ZotFlow's cache (files opened in its reader)
   - the vault
2. Text is extracted with Obsidian's own pdf.js: every page, with printed page
   labels.
3. Without the file, or for EPUB/snapshots: Zotero's full-text cache
   (`.zotero-ft-cache`). **Zotero cuts that off by default at 100 pages /
   500,000 characters**; the chat warns when this may have happened. In
   Zotero → Settings → Search you can raise the limits and rebuild the index.

A PDF with little or no text layer (a scan) is sent as PDF automatically.

## Settings

- **API key**: kept in Obsidian's secret storage, not in `data.json`.
- **Model**: "Load from API" fetches the models your key can use.
- Also: maximum answer length, default Text/PDF, annotations on/off, follow
  the active item, a size warning, answer language, custom instructions, chat
  folder, Zotero data folder (empty: ZotFlow Evo's, else `~/Zotero`).

## How it reads ZotFlow

- The IndexedDB database `zotflow-dev`, read-only: tables `items` and
  `files`, opened without a version so it never upgrades it, and closed when
  ZotFlow asks for a version change.
- ZotFlow Evo's settings from the plugin instance
  (`app.plugins.plugins["zotflow-evo"].settings`): storage path, linked-file
  base, data folder, group folders.
- Reader views by type: `zotflow-zotero-reader-view` (state `libraryID`,
  `itemKey`) and `zotflow-local-zotero-reader-view` (state `file`).
- Page links: `obsidian://zotflow?type=open-attachment&libraryID=…&key=…&navigation={"pageIndex":n}`.

If ZotFlow changes any of these, this plugin has to follow.

## Not yet

- Files only reachable over WebDAV that were never opened in ZotFlow (no
  download from here).
- Text of EPUBs and snapshots beyond Zotero's full-text cache.
- Chats are not kept across restarts unless saved as notes.

## Develop

```
npm install
npm test
npm run build
```

Releases for BRAT: raise `version` in `manifest.json` (and add it to
`versions.json`), push `main`. The workflow builds and publishes the release
with its tag. In BRAT, add `pad-mac/obsidian-zotero-ai`.
