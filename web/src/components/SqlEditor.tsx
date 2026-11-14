import CodeMirror, {
  Decoration,
  EditorView,
  ViewPlugin,
  keymap,
  type DecorationSet,
  type ReactCodeMirrorRef,
  type ViewUpdate,
} from '@uiw/react-codemirror';
import { sql as sqlLang, StandardSQL } from '@codemirror/lang-sql';
import { EditorSelection, Prec } from '@codemirror/state';
import { forwardRef, useMemo, useRef } from 'react';
import { formatRange } from '../utils/sqlFormat';
import { scanSql, statementAt, type TextRange } from '../utils/sqlStatements';

interface Props {
  value: string;
  onChange(v: string): void;
  /** Ctrl/Cmd+Enter; receives the main selection at the moment the keys were pressed. */
  onRun?(selection: TextRange): void;
  /** The main selection (or cursor, from === to) whenever it or the text changes. */
  onSelectionChange?(selection: TextRange): void;
  /** Shift+Alt+F (Format SQL); receives what happened so the parent can show a message. */
  onFormat?(outcome: FormatOutcome): void;
  readOnly?: boolean;
  /** Outline the statement under the cursor when the text holds several statements. */
  highlightStatement?: boolean;
  labelId: string;
}

export type FormatOutcome =
  | { ok: true; changed: boolean; scope: 'selection' | 'all' }
  | { ok: false; reason: string; scope: 'selection' | 'all' }
  | { ok: false; reason: 'read-only'; scope: 'none' };

/** Keyboard shortcut for Format SQL (CodeMirror key name and how it is shown). */
export const FORMAT_SQL_KEY = 'Shift-Alt-f';
export const FORMAT_SQL_KEY_LABEL = 'Shift+Alt+F';

/**
 * Formats the selection (or the whole text when nothing is selected) as one editor change, so
 * Ctrl/Cmd+Z undoes it. When the SQL cannot be formatted safely the text is left untouched.
 */
export function formatSqlInView(view: EditorView): FormatOutcome {
  if (view.state.readOnly) return { ok: false, reason: 'read-only', scope: 'none' };
  const { from, to } = view.state.selection.main;
  const r = formatRange(view.state.doc.toString(), { from, to });
  if (!r.ok) return r;
  if (r.changed) {
    const { edit } = r;
    view.dispatch({
      changes: edit,
      // keep a formatted selection selected; otherwise the cursor maps to the end of the change
      ...(r.scope === 'selection'
        ? { selection: EditorSelection.range(edit.from, edit.from + edit.insert.length) }
        : {}),
      // not an 'input.*' event, so the autocomplete popup does not open on the reformatted text
      userEvent: 'format',
      scrollIntoView: true,
    });
  }
  return { ok: true, changed: r.changed, scope: r.scope };
}

const statementMark = Decoration.mark({ class: 'qf-editor__statement' });

function statementDecorations(view: EditorView): DecorationSet {
  const sel = view.state.selection.main;
  if (!sel.empty) return Decoration.none;
  const text = view.state.doc.toString();
  const { statements } = scanSql(text);
  if (statements.length < 2) return Decoration.none;
  const s = statementAt(statements, sel.head);
  return s && s.to > s.from ? Decoration.set([statementMark.range(s.from, s.to)]) : Decoration.none;
}

/** Marks the statement Ctrl/Cmd+Enter would run when the editor holds several statements. */
const currentStatement = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = statementDecorations(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.selectionSet) this.decorations = statementDecorations(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

/**
 * SQL editor (CodeMirror 6) with syntax highlighting, line numbers, Ctrl/Cmd+Enter to run and
 * Shift+Alt+F to format.
 * The parent decides what Run executes from the selection it is given (see resolveRunTarget).
 */
export const SqlEditor = forwardRef<ReactCodeMirrorRef, Props>(function SqlEditor(
  { value, onChange, onRun, onFormat, onSelectionChange, readOnly, highlightStatement, labelId },
  ref,
) {
  // handlers live in refs so a new callback does not reconfigure the editor
  const onSel = useRef(onSelectionChange);
  onSel.current = onSelectionChange;
  const runRef = useRef(onRun);
  runRef.current = onRun;
  const formatRef = useRef(onFormat);
  formatRef.current = onFormat;
  const extensions = useMemo(
    () => [
      sqlLang({ dialect: StandardSQL, upperCaseKeywords: true }),
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: (view) => {
              const { from, to } = view.state.selection.main;
              runRef.current?.({ from, to });
              return true;
            },
          },
          {
            key: FORMAT_SQL_KEY,
            run: (view) => {
              const outcome = formatSqlInView(view);
              if (outcome.scope === 'none') return false;
              formatRef.current?.(outcome);
              return true;
            },
          },
        ]),
      ),
      EditorView.updateListener.of((u) => {
        if (u.selectionSet || u.docChanged) {
          const { from, to } = u.state.selection.main;
          onSel.current?.({ from, to });
        }
      }),
      ...(highlightStatement ? [currentStatement] : []),
    ],
    [highlightStatement],
  );
  return (
    <div className="qf-editor" data-testid="sql-editor">
      <CodeMirror
        ref={ref}
        value={value}
        onChange={onChange}
        extensions={extensions}
        readOnly={readOnly}
        basicSetup={{
          lineNumbers: true,
          foldGutter: false,
          autocompletion: true,
          highlightActiveLine: true,
        }}
        aria-labelledby={labelId}
        placeholder="SELECT * FROM MYLIB.MYTABLE FETCH FIRST 100 ROWS ONLY"
      />
    </div>
  );
});
