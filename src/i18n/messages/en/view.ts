/**
 * en/view — 视图层文案（`src/view/**` + `src/viewmodel/**` 展示层 + `src/shared/expression-copy.ts`）。
 *
 * 真相源：`MessageKey = keyof typeof en`（由 `messages/en/pack.ts` 合并推导）。
 * key 以 `view.` 开头，按组件分组（`view.search.*` / `view.outline.*` / `view.settings.*` …）。
 * 约定：`{n}` 参与 locale 千分位 + 复数选形，其余参数原样字符串化（`{n}` 以外的数字参数
 * 保持原样，避免把「行号 / 计数」这类既有口径改成带千分位）。
 */
export const view = {
  /* ---------------- 通用 ---------------- */
  /** 多条信息连接符（概要元信息行等） */
  'view.listSeparator': ' · ',

  /* ---------------- 文档显示名（shared/doc-name） ---------------- */
  'view.doc-name.originalTitle': '{name} (original: {originalName})',

  /* ---------------- 文档概要（profile-panel） ---------------- */
  'view.profile.empty.idle': 'No document open',
  'view.profile.empty.loading': 'Sampling…',
  'view.profile.empty.stale': 'Document changed; profile is out of date',
  'view.profile.empty.noFields': 'No fields to summarize',
  'view.profile.title.fields': 'Root fields',
  'view.profile.title.elements': 'Element fields',
  'view.profile.kind.mixed': 'mixed',
  'view.profile.nodes': '{nodes} nodes',
  'view.profile.nodesCompact': '{nodes} nodes',
  'view.profile.depth': 'depth {depth}',
  'view.profile.sampled': 'sampled {nodes}',
  'view.profile.truncated': 'truncated',
  'view.profile.freq': '×{freq}',
  /** zh 专用计数单位（en 走完整千分位数字，此值不会被渲染） */
  'view.profile.wanUnit': 'K',

  /* ---------------- 搜索面板（search-panel） ---------------- */
  'view.search.placeholder': 'Search keys, values, or paths…',
  'view.search.options.label': 'Search options',
  'view.search.case.label': 'Match case',
  'view.search.case.title': 'Match case (Aa)',
  'view.search.regex.label': 'Use regular expression',
  'view.search.regex.title': 'Use regular expression (.*)',
  'view.search.prev.label': 'Previous match',
  'view.search.prev.title': 'Previous match (⇧⌘G / ⇧F3)',
  'view.search.next.label': 'Next match',
  'view.search.next.title': 'Next match (⌘G / F3)',
  'view.search.filters.label': 'Result filters',
  'view.search.list.label': 'Search results, virtual scrolling list',
  'view.search.filter.all': 'All',
  'view.search.filter.key': 'Key',
  'view.search.filter.value': 'Value',
  'view.search.filter.path': 'Path',
  'view.search.empty.idle': 'Type a keyword to search keys, values, or paths',
  'view.search.empty.searching': 'Searching…',
  'view.search.empty.stale': 'Document changed; search again',
  'view.search.empty.noHits': 'No matches for “{query}”',
  'view.search.truncated': 'Truncated (limit {n})',
  'view.search.foot.prefix': 'Virtual scrolling · rendered ',

  /* ---------------- 大纲面板（outline-panel） ---------------- */
  'view.outline.empty.idle': 'Import a document to see the structural outline',
  'view.outline.empty.loading': 'Loading…',
  'view.outline.empty.error': 'Failed to load the outline',
  'view.outline.label': 'Document outline',
  'view.outline.foot.prefix': 'Rendered ',
  'view.outline.foot.suffix': ' rows',
  'view.outline.count': '{n} items',
  'view.outline.loadMore': 'Load more ({n} remaining)',
  'view.outline.aria.container': '{key} {kind} {n} items',
  'view.outline.aria.scalar': '{key} {kind}',

  /* ---------------- 树视图（tree-view / row-renderer） ---------------- */
  'view.tree.label': 'JSON tree view',
  'view.tree.action.copy': 'Copy subtree JSON',
  'view.tree.action.edit': 'Edit this node JSON',
  'view.tree.action.raw': 'Locate in source',
  'view.tree.count': '{n} items',
  'view.tree.expandHint': 'Click to expand',
  'view.tree.collapseHint': 'Click to collapse',
  'view.tree.originComputed': 'Computed value (no document path)',
  'view.tree.type.object': 'object',
  'view.tree.type.array': 'array',
  'view.tree.type.string': 'string',
  'view.tree.type.number': 'number',
  'view.tree.type.boolean': 'bool',
  'view.tree.type.null': 'null',

  /* ---------------- 原始文本视图（raw-view） ---------------- */
  'view.raw.label': 'Raw text view',
  'view.raw.locate': 'Locate in tree view (line {n})',
  'view.raw.truncated': 'This line has {n} more characters not shown (use “Copy source” to see all)',

  /* ---------------- 标签条（tab-strip） ---------------- */
  'view.tabstrip.add': 'New tab (⌘⇧O)',
  'view.tabstrip.addLabel': 'New tab',
  'view.tabstrip.limit': 'At most {n} tabs',
  'view.tabstrip.close': 'Close {name}',
  'view.tabstrip.renameLabel': 'Tab name (Enter to save, Esc to cancel)',

  /* ---------------- 设置面板（settings-panel） ---------------- */
  'view.settings.panelLabel': 'Settings',
  'view.settings.theme': 'Theme',
  'view.settings.theme.dark': 'Dark',
  'view.settings.theme.light': 'Light',
  'view.settings.rowHeight': 'Row height',
  'view.settings.indent': 'Indent',
  'view.settings.sortOrder': 'Child key order',
  'view.settings.sortOrder.hint':
    'Affects display order in the tree, outline, and expression result tree only; copy, export, and paths are unchanged',
  'view.settings.sort.raw': 'Original',
  'view.settings.sort.asc': 'Ascending',
  'view.settings.sort.desc': 'Descending',
  'view.settings.typeColumn': 'Show type column',
  'view.settings.typeColumn.hint': 'Show the JSON type to the right of each key',
  'view.settings.defaultCopyFormat': 'Default copy format',
  'view.settings.copy.subtree': 'Subtree JSON',
  'view.settings.copy.path': 'Path',
  'view.settings.copy.value': 'Raw value',
  'view.settings.copy.key': 'Key',
  'view.settings.jsonIndent': 'JSON indent',
  'view.settings.jsonIndent.compact': 'Compact',
  'view.settings.jsonIndent.spaces': '{n} spaces',
  'view.settings.searchCopyFormat': 'Double-click copy in search results',
  'view.settings.exportMode': 'Export method',
  'view.settings.exportMode.file': 'Export file',
  'view.settings.exportMode.clipboard': 'Copy to clipboard',
  'view.export.clipboardRefusal': 'Document is large ({mb} MB); use “Export JSON file” instead',
  'view.settings.repairTruncated': 'Repair truncated JSON on import',
  'view.settings.repairTruncated.hint': 'When off, truncated text fails with an error',
  'view.settings.adaptiveExpand': 'Auto-expand small documents',
  'view.settings.adaptiveExpand.hint': 'Up to 500 rows; when off, stays collapsed by default',
  'view.settings.advBudget': 'Advanced budget',
  'view.settings.budget.loose': 'Loose',
  'view.settings.budget.standard': 'Standard',
  'view.settings.budget.strict': 'Strict',
  'view.settings.escapeUnicode': 'Escape non-ASCII on export',
  'view.settings.escapeUnicode.hint': 'Non-ASCII is written as \\uXXXX; still valid JSON',
  'view.settings.importTarget': 'Import destination',
  'view.settings.importTarget.hint':
    'Initial choice when the import dialog opens from the toolbar; dropping onto a document or pasting always asks first',
  'view.settings.importTarget.newTab': 'New tab',
  'view.settings.importTarget.replace': 'Replace current',
  'view.settings.language': 'Language',
  'view.settings.language.auto': 'System',
  'view.settings.language.hint': 'Applies immediately; “System” follows the browser language',

  /* ---------------- 表达式（expression-copy / expression-panel / expression-bar） ---------------- */
  'view.expr.panelLabel': 'Expression panel',
  'view.expr.panelTitle': 'Expression',
  'view.expr.run': 'Run',
  'view.expr.running': 'Running…',
  'view.expr.runTitle': 'Run expression (Enter)',
  'view.expr.strict': 'Strict mode',
  'view.expr.examplesTitle': 'Examples',
  'view.expr.filterHint':
    'Multi-condition filtering: use filter(...) with an element field, e.g. $.items.filter(x => x.a === 1 && x.b === 2)',
  'view.expr.historyTitle': 'History',
  'view.expr.empty': 'Type an expression, then press Enter to run',
  'view.expr.stale': 'Document changed; the result may be out of date',
  'view.expr.rerun': 'Run again',
  'view.expr.back': 'Back to document tree',
  'view.expr.resultTitle': 'Expression result · {rootId}',
  'view.expr.status': '{count} items · {ms} ms',
  'view.expr.truncated': 'Truncated (limit {n})',
  'view.expr.skipped': 'Skipped {n} items missing that field',
  'view.expr.noSource': 'This row is a computed value; it has no source position',
  'view.expr.readonly': 'Expression results are read-only',
  'view.expr.watchdog': 'Expression timed out and the worker was terminated; re-import the document',
  'view.expr.editorLabel': 'Expression input',
  'view.expr.editorLoading': 'Loading editor…',
  'view.expr.editorFailed': 'Failed to load the editor; try again',

  /* 错误文案（引擎只给 code + params，见 shared/expression-copy.ts） */
  'view.expr.error.parseSyntax': 'Syntax error',
  'view.expr.error.parseRootShape': 'Must be a single expression',
  'view.expr.error.staticNode': 'Unsupported syntax: {detail}',
  'view.expr.error.staticCall': 'Calling is not allowed: {name}',
  'view.expr.error.evalShape': 'Evaluation failed: {detail}',
  'view.expr.error.unknownField': 'Field does not exist: {field}',
  'view.expr.error.stepLimit': 'Step limit exceeded (budget {budget})',
  'view.expr.error.timeLimit': 'Timed out (budget {budget} ms)',
  'view.expr.error.illegalCall': 'Call not allowed: {name}',
  'view.expr.error.mixedNumber': 'Big integers cannot be used in this operation: {op}',
  'view.expr.error.divByZero': 'Division by zero',
  'view.expr.error.resultTruncated': 'Result truncated (limit {max})',
  'view.expr.param.depth': 'Expression nested too deeply',
  'view.expr.param.textLength': 'Expression is too long',
  'view.expr.param.rootShape': 'Must be a single expression',
  'view.expr.param.baseKind': 'Cannot access a field on a value that is not an object',
  'view.expr.param.index': 'Index must be a non-negative integer',
  'view.expr.candidates': ' (Did you mean {hint}?)',

  /* ---------------- 编辑弹层（subtree-editor） ---------------- */
  'view.edit.title': 'Edit node JSON',
  'view.edit.apply': 'Apply',
  'view.edit.applying': 'Applying…',
  'view.edit.limitHint': 'This subtree is over 5 MB and is read-only; pick a smaller subtree',

  /* ---------------- 行列位置后缀（表达式错误 / 编辑诊断共用） ---------------- */
  'view.location.line': ' (line {line})',
  'view.location.lineColumn': ' (line {line}, column {column})',
  /** 已含位置后缀的探测前缀（避免重复拼接） */
  'view.location.marker': ' (line ',
} as const;

export type ViewMessages = typeof view;
