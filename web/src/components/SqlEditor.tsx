import CodeMirror, { keymap, type ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { sql as sqlLang, StandardSQL } from '@codemirror/lang-sql';
import { Prec } from '@codemirror/state';
import { forwardRef, useMemo } from 'react';

interface Props {
  value: string;
  onChange(v: string): void;
  onRun?(): void;
  readOnly?: boolean;
  labelId: string;
}

/** SQL editor (CodeMirror 6) with syntax highlighting, line numbers and Ctrl/Cmd+Enter to run. */
export const SqlEditor = forwardRef<ReactCodeMirrorRef, Props>(function SqlEditor(
  { value, onChange, onRun, readOnly, labelId },
  ref,
) {
  const extensions = useMemo(
    () => [
      sqlLang({ dialect: StandardSQL, upperCaseKeywords: true }),
      Prec.highest(
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              onRun?.();
              return true;
            },
          },
        ]),
      ),
    ],
    [onRun],
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
