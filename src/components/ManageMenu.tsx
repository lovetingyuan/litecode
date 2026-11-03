import { Menu } from "@base-ui/react/menu";
import { commands, execute } from "../core/commands";
import workbenchStyles from "../styles/workbench.module.css";
import { Icon } from "./ui";

const settingsItems = [
  { id: "workbench.action.openSettingsJson", label: "Settings (JSON)" },
  { id: "workbench.action.openGlobalKeybindingsFile", label: "Keyboard Shortcuts (JSON)" },
  { id: "litecode.importSettings", label: "Review VS Code Settings Import…" },
];

export function ManageMenu() {
  const palette = commands.find((command) => command.id === "workbench.action.showCommands");

  return (
    <Menu.Root>
      <Menu.Trigger title="Manage" aria-label="Manage">
        <Icon name="settings-gear" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="z-90" side="right" align="end" sideOffset={4}>
          <Menu.Popup
            aria-label="Manage"
            className={`context-menu bg-menu text-foreground p-1 border border-strong rounded-[6px] min-w-75 max-w-[var(--available-width)] max-h-[var(--available-height)] overflow-auto ${workbenchStyles["context-menu"]}`}
          >
            <Menu.Item onClick={() => void execute("workbench.action.showCommands")}>
              <span>Command Palette…</span>
              {palette?.key && <kbd className="text-muted">{palette.key}</kbd>}
            </Menu.Item>
            <Menu.Separator className="h-px bg-strong my-1" />
            {settingsItems.map((item) => (
              <Menu.Item key={item.id} onClick={() => void execute(item.id)}>
                {item.label}
              </Menu.Item>
            ))}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
