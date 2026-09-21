import { createSignal } from "solid-js";
import { api, type CommandSnippet, type CommandVariable } from "../utils/api";

/** 命令模板共享存储：设置页与命令广播面板共用同一份数据，增删改后立即同步。 */
const [templates, setTemplates] = createSignal<CommandSnippet[]>([]);

const upsert = (snippet: CommandSnippet) => setTemplates(previous => {
  const rest = previous.filter(item => item.id !== snippet.id);
  return [snippet, ...rest];
});

export const templateStore = {
  templates,
  async refresh(): Promise<CommandSnippet[]> {
    const list = await api.listCommandSnippets("snippet").catch(() => [] as CommandSnippet[]);
    setTemplates(list);
    return list;
  },
  async save(input: { id?: string; name: string; content: string; tags?: string[]; variables?: CommandVariable[] }): Promise<CommandSnippet> {
    const saved = await api.saveCommandSnippet({ ...input, kind: "snippet" });
    upsert(saved);
    return saved;
  },
  async remove(id: string): Promise<void> {
    await api.deleteCommandSnippet(id);
    setTemplates(previous => previous.filter(item => item.id !== id));
  },
  /** 本地新增未保存草稿（三无条目），保存后才写入数据库。 */
  addDraft(): CommandSnippet {
    const draft: CommandSnippet = {
      id: `draft-${crypto.randomUUID()}`,
      kind: "snippet",
      name: "未命名模板",
      content: "",
      tags: "[]",
      variables: "[]",
      favorite: false,
      created_at: 0,
      updated_at: 0,
    };
    setTemplates(previous => [draft, ...previous]);
    return draft;
  },
  discardDraft(id: string): void {
    setTemplates(previous => previous.filter(item => item.id !== id));
  },
};
