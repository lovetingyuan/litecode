import { useRef, useState, type ReactElement } from 'react';
import { ContextMenu } from '@base-ui/react/context-menu';
import { canRevealInExplorer, commandShortcut, execute, keyContext } from './commands';
import { tabsToClose } from './documents';
import { useApp } from './store';
import type { CloseTabsMode } from './documents';
import type { Group } from './types';

const closeItems: [string, string, CloseTabsMode | null][] = [
  ['workbench.action.closeActiveEditor', 'Close', null],
  ['workbench.action.closeOtherEditors', 'Close Others', 'others'],
  ['workbench.action.closeEditorsToTheRight', 'Close to the Right', 'right'],
  ['workbench.action.closeUnmodifiedEditors', 'Close Saved', 'saved'],
  ['workbench.action.closeEditorsInGroup', 'Close All', 'all'],
];

export function EditorTabMenu({ group, documentId, children }: { group: Group; documentId: string; children: ReactElement }) {
  const [open, setOpen] = useState(false);
  const restoreTrigger = useRef(true);
  const doc = useApp(s => s.docs[documentId]);
  const keybindings = useApp(s => s.keybindings);
  const [trigger, setTrigger] = useState<HTMLDivElement | null>(null);
  const context = { groupId: group.id, documentId };
  const sticky = !!group.sticky?.includes(documentId);
  const groups = open ? [
    closeItems.map(([id, label, mode]) => ({ id, label, disabled: !!mode && !tabsToClose(group, documentId, mode).length })),
    [{ id: 'copyFilePath', label: 'Copy Path', disabled: !doc?.path }, { id: 'copyRelativeFilePath', label: 'Copy Relative Path', disabled: !doc?.path }],
    [{ id: 'revealFileInOS', label: 'Reveal in File Explorer', disabled: !doc?.path }, { id: 'workbench.files.action.showActiveFileInExplorer', label: 'Reveal in Explorer View', disabled: !canRevealInExplorer(doc?.path ?? null) }],
    [{ id: sticky ? 'workbench.action.unpinEditor' : 'workbench.action.pinEditor', label: sticky ? 'Unpin' : 'Pin', disabled: false }],
    [{ id: 'workbench.action.splitEditorRight', label: 'Split Right', disabled: false }],
  ] : [];
  return <ContextMenu.Root open={open && !!doc} onOpenChange={next => { if (next) restoreTrigger.current = true; setOpen(next); }}>
    <ContextMenu.Trigger ref={setTrigger} render={children} onKeyDown={event => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault(); event.stopPropagation();
      const rect = event.currentTarget.getBoundingClientRect();
      event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left + 12, clientY: rect.bottom }));
    }} />
    <ContextMenu.Portal>
      <ContextMenu.Positioner className="z-90" sideOffset={0} alignOffset={0} collisionPadding={6}>
        <ContextMenu.Popup className="context-menu editor-tab-menu" aria-label={`Actions for ${doc?.name ?? 'editor'}`} finalFocus={type => type === 'keyboard' && restoreTrigger.current ? trigger : false}>
          {groups.map((items, index) => <ContextMenu.Group key={index}>
            {index > 0 && <ContextMenu.Separator className="editor-tab-menu-separator" />}
            {items.map(item => <ContextMenu.Item key={item.id} aria-label={item.label} disabled={item.disabled} onClick={() => {
              restoreTrigger.current = !['workbench.files.action.showActiveFileInExplorer', 'workbench.action.splitEditorRight'].includes(item.id);
              void execute(item.id, context);
            }}>
              <span>{item.label}</span><kbd>{trigger && commandShortcut(item.id, keyContext(trigger, context), keybindings)}</kbd>
            </ContextMenu.Item>)}
          </ContextMenu.Group>)}
        </ContextMenu.Popup>
      </ContextMenu.Positioner>
    </ContextMenu.Portal>
  </ContextMenu.Root>;
}
