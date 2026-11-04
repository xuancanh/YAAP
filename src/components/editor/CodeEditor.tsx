/**
 * The code and text editor (docs/filesystem.md "Editing"): CodeMirror 6 with
 * line numbers, search (⌘F), history, bracket matching and folding; the
 * language comes from the file name (@codemirror/language-data loads each
 * grammar on demand); JSON is linted as you type. Themed from the app's
 * tokens so it follows light and dark. Lazy-loaded.
 */
import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { Compartment, EditorState } from '@codemirror/state';
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { linter, lintGutter } from '@codemirror/lint';
import { indentWithTab } from '@codemirror/commands';
import { tags as t } from '@lezer/highlight';

const theme = EditorView.theme({
  '&': { color: 'var(--text)', backgroundColor: 'var(--code)' },
  '.cm-content': { caretColor: 'var(--accent-hi)', padding: '10px 0' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent-hi)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'color-mix(in oklab, var(--accent) 30%, transparent) !important' },
  '.cm-gutters': { backgroundColor: 'var(--code)', color: 'var(--text-faint)', border: 'none', borderRight: '1px solid var(--border-soft)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in oklab, var(--hover) 55%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-dim)' },
  '.cm-panels': { backgroundColor: 'var(--panel-2)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-panels input, .cm-panels button': { fontFamily: 'inherit' },
  '.cm-textfield': { backgroundColor: 'var(--bg)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '5px' },
  '.cm-button': { backgroundImage: 'none', backgroundColor: 'var(--panel)', border: '1px solid var(--border)', color: 'var(--text)', borderRadius: '5px' },
  '.cm-searchMatch': { backgroundColor: 'color-mix(in oklab, var(--amber) 28%, transparent)' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: 'color-mix(in oklab, var(--amber) 50%, transparent)' },
  '.cm-tooltip': { backgroundColor: 'var(--elev)', border: '1px solid var(--border)', color: 'var(--text)' },
  '.cm-foldPlaceholder': { backgroundColor: 'var(--panel-2)', border: 'none', color: 'var(--text-faint)' },
  '.cm-matchingBracket': { backgroundColor: 'color-mix(in oklab, var(--accent) 22%, transparent)', outline: 'none' },
});

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: 'var(--tok-kw)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--tok-str)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--tok-num)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--tok-com)', fontStyle: 'italic' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--tok-fn)' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--tok-type)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--tok-prop)' },
  { tag: [t.tagName, t.heading], color: 'var(--tok-tag)', fontWeight: '600' },
  { tag: [t.meta, t.annotation], color: 'var(--tok-meta)' },
  { tag: [t.link, t.url], color: 'var(--accent-hi)', textDecoration: 'underline' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
  { tag: [t.punctuation, t.bracket], color: 'var(--text-dim)' },
]);

export interface CodeEditorProps {
  text: string;
  /** The file name: picks the language. */
  name: string;
  onChange: (get: () => string) => void;
  onSave?: () => void;
  /** Wrap long lines (prose-ish text files). */
  wrap?: boolean;
  onReady?: (view: EditorView) => void;
}

export default function CodeEditor({ text, name, onChange, onSave, wrap, onReady }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const live = useRef({ onChange, onSave });
  live.current = { onChange, onSave };

  useEffect(() => {
    if (!host.current) return;
    const lang = new Compartment();
    const isJson = /\.(json|jsonc)$/i.test(name);
    const view = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          keymap.of([indentWithTab, { key: 'Mod-s', preventDefault: true, run: () => { live.current.onSave?.(); return true; } }]),
          theme,
          syntaxHighlighting(highlight),
          lang.of(isJson ? json() : []),
          ...(isJson ? [linter(jsonParseLinter(), { delay: 300 }), lintGutter()] : []),
          ...(wrap ? [EditorView.lineWrapping] : []),
          EditorView.contentAttributes.of({ 'aria-label': `Edit ${name}` }),
          EditorView.updateListener.of((u) => { if (u.docChanged) live.current.onChange(() => u.view.state.doc.toString()); }),
        ],
      }),
    });
    if (!isJson) {
      const desc = LanguageDescription.matchFilename(languages, name);
      if (desc) void desc.load().then((support) => { if (!view.dom.isConnected) return; view.dispatch({ effects: lang.reconfigure(support) }); }).catch(() => undefined);
    }
    onReady?.(view);
    return () => view.destroy();
    // remounted (key) when the text is replaced
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="cm-host" ref={host} data-testid="code-editor" />;
}
