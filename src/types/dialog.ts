export type DialogAction = {
  choice: string | string[];
  label: string;
  retry?: boolean;
  run: (choice: string, value?: string) => Promise<void | false>;
};

export type DialogOptions = {
  items?: string[];
  itemsLabel?: string;
  signal?: AbortSignal;
  defaultChoice?: string;
  action?: DialogAction;
  links?: { label: string; url: string }[];
};

export type InputAction = { label: string; run: (value: string) => Promise<void> };

export type DialogRequest = Omit<DialogOptions, "signal"> & {
  title: string;
  message?: string;
  value?: string;
  choices: string[];
  working?: string;
  error?: string;
  resolve: (choice: string | null, value?: string) => void;
};
