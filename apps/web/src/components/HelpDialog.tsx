import { TEST_IDS } from '@octopus-diff/contracts';
import { SHORTCUTS } from '../state/commandRegistry.ts';
import { useUiStore } from '../state/ui.tsx';
import { Dialog } from './Dialog.tsx';

export function HelpDialog() {
  const store = useUiStore();
  return (
    <Dialog
      title="Keyboard shortcuts"
      onClose={() => store.setState({ helpOpen: false })}
      testId={TEST_IDS.helpDialog}
    >
      <table className="w-full text-xs">
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.description} className="border-b border-line last:border-0">
              <td className="py-1.5 pr-4 whitespace-nowrap">
                {s.keys.map((k, i) => (
                  <span key={k}>
                    {i > 0 && <span className="px-1 text-faint">{s.chord ? 'then' : '/'}</span>}
                    <kbd>{k}</kbd>
                  </span>
                ))}
              </td>
              <td className="py-1.5 text-muted">{s.description}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-[11px] text-faint">
        Shortcuts are disabled while typing in a text field. Tab moves between panes; arrow keys
        move within the file list.
      </p>
    </Dialog>
  );
}
