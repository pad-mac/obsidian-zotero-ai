# Zotero AI

An Obsidian chat pane for asking Claude about the PDFs and books in your
Zotero library. It works alongside **ZotFlow Evo** (`pad-mac/zotflow-evo`):
it reads ZotFlow's database for the items and your annotations, and finds the
files on this computer by itself. Claude Desktop does not need to run.

Two ways to get answers, chosen in the settings (with the model):

- **API key:** billed per use in the Claude Console, separately from a
  Claude plan (Max and Ultra include monthly API credits).
- **Claude Code (subscription):** the `claude` command on this computer,
  signed in with your Claude plan. This counts against the plan's usage
  limits, not credits. The copy of Claude Code inside Claude Desktop can't
  be used for this. Install the command once (PowerShell:
  `irm https://claude.ai/install.ps1 | iex`), then run `claude` once and
  sign in with your Claude account.

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
- **Chats are kept**, each as a JSON file in the plugin's folder
  (`.obsidian/plugins/zotero-ai/chats/`), saved after every answer. The
  commands "New chat", "Chat history", "Save chat as note" and "Recover
  Claude Code chats" (also in the pane's right-click menu) replace any
  buttons. New chat keeps the old one in the history. The pane reopens the last chat after a restart. On opening, it
  also reads back chats from Claude Code's own session files
  (`~/.claude/projects/*obsidian-zotero-ai*/`), including ones from before
  the history existed. Those can be continued, since the session holds the
  documents.
- **Save chat as note** writes the chat into the chat folder. The
  frontmatter links the sources' `@citekey` notes.
- Documents are marked for prompt caching, so follow-up questions within a few
  minutes are much cheaper. Each answer shows its tokens (in, cached, out) on
  hover.

## The pane

No header, no buttons: the model is set in the settings, and the actions are
commands and the right-click menu. The tab bar stays.

## Claude Code backend

- **One process per question.** The first question sends the documents.
  Later questions continue the same Claude Code session (`--resume`), so
  Claude Code's own prompt caching applies.
- **If you add documents or change pages mid-chat,** a new session starts.
  It gets the documents and the conversation so far.
- **Claude Code runs as a plain reader, not an agent:**
  - `--tools ""`, `--strict-mcp-config`, `--setting-sources ""` and
    `--disable-slash-commands`: no tools, no MCP servers, no settings
    files, no commands.
  - Its system prompt is replaced by the plugin's.
  - It runs in a temporary folder, so your vault's or projects' `CLAUDE.md`
    files are not read.
- `ANTHROPIC_API_KEY` is removed from Claude Code's environment; with that
  variable set it would bill the key instead of the plan.
- **No answer length limit** in this mode, and how cached tokens count
  against plan limits is not documented by Anthropic.
- Settings → "Path to claude" → **Test** shows whether the plugin finds it.

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

- **Answer length** (short / medium / detailed), answer language and custom
  instructions go into the instructions Claude gets, for both backends.
  "Short" is the default.
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

## Develop

```
npm install
npm test
npm run build
```

Releases for BRAT: raise `version` in `manifest.json` (and add it to
`versions.json`), push `main`. The workflow builds and publishes the release
with its tag. In BRAT, add `pad-mac/obsidian-zotero-ai`.
