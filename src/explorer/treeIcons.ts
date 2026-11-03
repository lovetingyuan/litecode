import type { FileTreeIconConfig } from "@pierre/trees";

export const treeIcons: FileTreeIconConfig = {
  set: "complete",
  colored: true,
  spriteSheet: `<svg data-icon-sprite aria-hidden="true" width="0" height="0">
    <symbol id="litecode-test" viewBox="0 0 16 16">
      <g fill="var(--trees-icon-orange)">
        <path d="M8 1C2.24 1 1 2.24 1 8s1.24 7 7 7 7-1.24 7-7-1.24-7-7-7" opacity=".2"/>
        <path d="M6 3.5h4M7 3.5v5l-2.2 2.9a.7.7 0 0 0 .56 1.1h5.28a.7.7 0 0 0 .56-1.1L9 8.5v-5M6.3 9.5h3.4"
          fill="none" stroke="var(--trees-icon-orange)" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>
      </g>
    </symbol>
  </svg>`,
  byFileExtension: Object.fromEntries(
    ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].flatMap((extension) =>
      ["test", "spec"].map((suffix) => [`${suffix}.${extension}`, "litecode-test"]),
    ),
  ),
};
