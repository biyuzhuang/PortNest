import { Component, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { Icon } from "../../Icon";
import type { DatabaseTableDefinition } from "../../../utils/api";
import type { WorkspaceState } from "../../../stores/databaseWorkspaceStore";
import type { FilterSpec, SortOrder, TableTab } from "../types";
import { DataToolbar } from "./DataToolbar";
import { DataGrid, type CellEdit } from "./DataGrid";
import { DataFormView } from "./DataFormView";
import { DataStatusBar } from "./DataStatusBar";
import { FilterSortPanel } from "./FilterSortPanel";
import { StructureView } from "./StructureView";
import { DesignerView } from "../designer/DesignerView";

export type TableActions = {
  onSectionChange: (section: TableTab["section"]) => void;
  onRefresh: () => void;
  onSort: (column: string) => void;
  onApplyFilters: (filters: FilterSpec, orders: SortOrder[]) => void;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  onStop: () => void;
  onCommitCell: (edit: CellEdit) => void;
  onInsertedEdit: (id: number, column: string, raw: string) => void;
  onAddRecord: () => void;
  onDeleteSelected: () => void;
  onToggleRow: (key: string) => void;
  onToggleAll: () => void;
  onDiscard: () => void;
  onApplyChanges: () => void;
  onCopySelected: () => void;
  onCopyAs: (kind: "insert" | "update" | "json") => void;
  onExportSelected: () => void;
  onExportPage: () => void;
  onExportCsvFile: () => void;
  onOpenDdl: () => void;
  onResizeColumn: (column: string, width: number) => void;
  onFormIndexChange: (index: number) => void;
  onDesignChange: (definition: DatabaseTableDefinition) => void;
  onPreviewDesign: () => void;
  onApplyDesign: () => void;
  onDiscardDesign: () => void;
  onImportCsv: (file: File) => void;
};

type Props = {
  state: WorkspaceState;
  tab: TableTab;
  protocol: string;
  running: boolean;
  readOnly: boolean;
  actions: TableActions;
};

export const TableWorkspace: Component<Props> = props => {
  const [filterOpen, setFilterOpen] = createSignal(false);
  const [autoRefresh, setAutoRefresh] = createSignal(false);
  const [formIndex, setFormIndex] = createSignal(0);
  let fileInput: HTMLInputElement | undefined;

  const pendingCount = () => {
    const pending = props.tab.pending;
    return pending.inserted.length + Object.keys(pending.updates).length + Object.keys(pending.deletes).length;
  };

  // 自动刷新：有未提交修改或正在执行时跳过，避免覆盖正在编辑的内容
  createEffect(() => {
    if (!autoRefresh()) return;
    const timer = window.setInterval(() => {
      if (pendingCount() === 0 && !props.running) props.actions.onRefresh();
    }, 10_000);
    onCleanup(() => window.clearInterval(timer));
  });

  const sections: Array<{ key: TableTab["section"]; label: string }> = [
    { key: "data", label: "数据" },
    { key: "structure", label: "结构" },
    { key: "design", label: "设计表" },
    { key: "transfer", label: "导入/导出" },
  ];

  return (
    <section class="db-section">
      <header class="db-section-nav">
        <nav role="tablist" aria-label="表视图">
          {sections.map(item => (
            <button
              role="tab"
              aria-selected={props.tab.section === item.key}
              class={props.tab.section === item.key ? "is-active" : ""}
              disabled={props.tab.isNew && item.key !== "design"}
              onClick={() => props.actions.onSectionChange(item.key)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <span class="db-toolbar-spacer" />
        <span class="db-status-item is-muted">
          {props.tab.database} / {props.tab.isNew ? "新表" : props.tab.table}
        </span>
      </header>

      <Show when={props.tab.section === "data"}>
        <div class="db-data">
          <DataToolbar
            pendingCount={pendingCount()}
            running={props.running}
            filters={props.tab.filters}
            orders={props.tab.orders}
            filterOpen={filterOpen()}
            dataView={props.tab.dataView}
            onRefresh={() => props.actions.onRefresh()}
            onApply={() => props.actions.onApplyChanges()}
            onDiscard={() => props.actions.onDiscard()}
            onStop={() => props.actions.onStop()}
            onAddRecord={() => props.actions.onAddRecord()}
            onDeleteSelected={() => props.actions.onDeleteSelected()}
            onCopySelected={() => props.actions.onCopySelected()}
            onCopyAs={kind => props.actions.onCopyAs(kind)}
            onExportSelected={() => props.actions.onExportSelected()}
            onExportPage={() => props.actions.onExportPage()}
            onOpenDdl={() => props.actions.onOpenDdl()}
            onToggleFilter={() => setFilterOpen(value => !value)}
            onViewChange={view => props.state.patchTab(props.tab.id, { dataView: view })}
            onRemoveCondition={index => {
              const conditions = props.tab.filters.conditions.filter((_item, i) => i !== index);
              props.actions.onApplyFilters({ ...props.tab.filters, conditions }, props.tab.orders);
            }}
            onClearSort={() => props.actions.onApplyFilters(props.tab.filters, [])}
          />

          <Show when={filterOpen()}>
            <FilterSortPanel
              columns={props.tab.columns}
              filters={props.tab.filters}
              orders={props.tab.orders}
              onClose={() => setFilterOpen(false)}
              onApply={(filters, orders) => { props.actions.onApplyFilters(filters, orders); setFilterOpen(false); }}
            />
          </Show>

          <Show when={props.tab.rows} fallback={<div class="db-grid-wrap"><div class="db-skeleton">{Array.from({ length: 14 }).map(() => <span />)}</div></div>}>
            <Show
              when={props.tab.dataView === "grid"}
              fallback={
                <DataFormView
                  result={props.tab.rows!}
                  columns={props.tab.columns}
                  pending={props.tab.pending}
                  primaryKey={props.tab.primaryKey}
                  index={Math.min(formIndex(), Math.max(0, props.tab.rows!.rows.length - 1))}
                  readOnly={props.readOnly}
                  onIndexChange={index => { setFormIndex(index); props.actions.onFormIndexChange(index); }}
                  onCommit={edit => props.actions.onCommitCell(edit)}
                />
              }
            >
              <DataGrid
                result={props.tab.rows!}
                columns={props.tab.columns}
                pending={props.tab.pending}
                orders={props.tab.orders}
                primaryKey={props.tab.primaryKey}
                columnWidths={props.tab.columnWidths}
                readOnly={props.readOnly}
                onSort={column => props.actions.onSort(column)}
                onToggleRow={key => props.actions.onToggleRow(key)}
                onToggleAll={() => props.actions.onToggleAll()}
                onCommit={edit => props.actions.onCommitCell(edit)}
                onInsertedEdit={(id, column, raw) => props.actions.onInsertedEdit(id, column, raw)}
                onResize={(column, width) => props.actions.onResizeColumn(column, width)}
                onRowFocus={index => setFormIndex(index)}
              />
            </Show>

            <DataStatusBar
              statement={props.tab.rows!.statement}
              tableName={props.tab.table}
              page={props.tab.page}
              pageSize={props.tab.pageSize}
              rowCount={props.tab.rows!.rows.length}
              elapsedMs={props.tab.rows!.execution_time_ms}
              truncated={props.tab.rows!.truncated}
              selectedCount={Object.keys(props.tab.pending.selected).length}
              pendingCount={pendingCount()}
              autoRefresh={autoRefresh()}
              onCopySql={() => {
                const statement = props.tab.rows?.statement;
                if (statement) void navigator.clipboard.writeText(statement);
              }}
              onPageChange={page => props.actions.onPageChange(page)}
              onPageSizeChange={size => props.actions.onPageSizeChange(size)}
              onToggleAutoRefresh={value => setAutoRefresh(value)}
            />
          </Show>
        </div>
      </Show>

      <Show when={props.tab.section === "structure"}>
        <StructureView columns={props.tab.columns} indexes={props.tab.indexes} onShowDdl={() => props.actions.onOpenDdl()} />
      </Show>

      <Show when={props.tab.section === "design"}>
        <Show when={props.tab.designer} fallback={<div class="db-grid-empty"><p>正在准备设计器…</p></div>}>
          <DesignerView
            protocol={props.protocol}
            definition={props.tab.designer!}
            base={props.tab.isNew ? null : props.tab.designerBase ?? null}
            preview={props.tab.preview}
            isNew={!!props.tab.isNew}
            onChange={definition => props.actions.onDesignChange(definition)}
            onPreview={() => props.actions.onPreviewDesign()}
            onApply={() => props.actions.onApplyDesign()}
            onDiscard={() => props.actions.onDiscardDesign()}
          />
        </Show>
      </Show>

      <Show when={props.tab.section === "transfer"}>
        <div class="db-transfer">
          <div class="db-transfer-card">
            <h4><Icon name="import" size={14} />导入 CSV</h4>
            <p>首行为列名，导入在事务中执行，任一行失败整体回滚。</p>
            <input
              ref={element => { fileInput = element; }}
              type="file"
              accept=".csv"
              class="db-hidden-input"
              onChange={event => {
                const file = event.currentTarget.files?.[0];
                if (file) props.actions.onImportCsv(file);
                if (fileInput) fileInput.value = "";
              }}
            />
            <button class="db-btn" onClick={() => fileInput?.click()}>选择 CSV 文件</button>
          </div>
          <div class="db-transfer-card">
            <h4><Icon name="export" size={14} />导出</h4>
            <p>导出当前页为 CSV，或用对象面板的「导出 SQL」导出整库结构与数据。</p>
            <button class="db-btn" onClick={() => props.actions.onExportCsvFile()}>导出本页 CSV</button>
          </div>
        </div>
      </Show>
    </section>
  );
};
