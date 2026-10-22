// Replaces the pinned controller's old synchronous rename implementation.
export const editingMethods = String.raw`
	getEditSession() { return this.#editSession; }
	getEditingPath() { return this.#editSession?.path ?? null; }
	getCreatingPath() { return this.#editSession?.mode === "create" ? this.#editSession.path : null; }
	cancelEditing() { this.#editSession?.dispose(); }
	cancelCreating() { if (this.#editSession?.mode === "create") this.cancelEditing(); }
	#beginEditing(options) {
		this.cancelEditing();
		const session = new InlineEditSession(this, options, () => this.#emit(), () => {
			if (this.#editSession !== session) return;
			this.#editSession = null;
			if (session.mode === "create" && this.getItem(session.path)) this.remove(session.path, { recursive: true });
			if (this.getSelectedPaths().length === 0 && options.parentPath) this.selectOnlyPath(options.parentPath);
			this.#emit();
		});
		if (session.mode === "create") this.add(session.path);
		this.#editSession = session;
		this.selectOnlyPath(session.path);
		this.scrollToPath(session.path, { focus: false, offset: "nearest" });
		this.#emit();
		return session.path;
	}
	startCreating(options) {
		this.cancelEditing();
		const parent = options.parentPath.replace(/\/$/, "");
		if (parent && !this.getItem(parent)?.isDirectory()) return null;
		if (parent) this.#expandDirectory(parent + "/");
		return this.#beginEditing({ ...options, parentPath: parent, mode: "create" });
	}
	startRenaming(path = this.#focusedPath ?? "", _options = {}) {
		if (!this.#renameEnabled) return false;
		this.cancelEditing();
		const info = this.#store.getPathInfo(path);
		if (!info) return false;
		const canonical = info.path;
		const folder = isCanonicalDirectoryPath(canonical);
		const item = { path: toRenameHelperPath(canonical), isFolder: folder };
		if (this.#renameCanRename?.(item) === false) return false;
		const hooks = this.#renameStart?.(item);
		if (this.#renameStart && !hooks) return false;
		for (const ancestor of getAncestorDirectoryPaths(canonical)) this.#store.expand(ancestor);
		const validate = value => {
			const result = renameFileTreePaths({ files: this.#store.list(), isFolder: folder, nextBasename: value, path: item.path });
			return "error" in result ? result.error : null;
		};
		this.#beginEditing({
			mode: "rename", path: canonical, kind: folder ? "newFolder" : "newFile",
			parentPath: getImmediateParentPath(canonical) ?? "", initialValue: getRenameLeafName(canonical),
			validateSync: hooks?.validateSync, validate: hooks?.validate ?? validate,
			onCancel: hooks?.onCancel, onFinish: hooks?.onFinish,
			onCommit: hooks?.onCommit ?? (async value => {
				const result = renameFileTreePaths({ files: this.#store.list(), isFolder: folder, nextBasename: value, path: item.path });
				if ("error" in result) throw new Error(result.error);
				await this.#onRename?.({ sourcePath: result.sourcePath, destinationPath: result.destinationPath, isFolder: folder });
				this.move(canonical, toCanonicalRenamePath(result.destinationPath, folder));
			}),
		});
		return true;
	}
	#cancelRenaming() { this.#editSession?.cancel(); }
	#completeRenaming() { void this.#editSession?.commit(); }
	#setRenamingValue(value) { this.#editSession?.setValue(value); }
	resetPaths(pathsOrOptions, maybeOptions = {}) {
		this.cancelEditing();`;
