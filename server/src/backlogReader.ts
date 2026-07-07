import * as fs from 'fs';
import * as path from 'path';

export interface BacklogTask {
  id: string;
  title: string;
  status: string;
  assignee: string[];
  labels: string[];
  priority?: string;
  milestone?: string;
}

const BACKLOG_DIR = 'backlog';
const TASKS_DIR = 'tasks';

const LINE_RE = /^(\w[\w ]*?):\s*(.*)$/;
const ARRAY_RE = /^\[(.*)\]$/;

function parseValue(raw: string): string | string[] {
  const trimmed = raw.trim();
  const arrMatch = trimmed.match(ARRAY_RE);
  if (arrMatch) {
    const inner = arrMatch[1].trim();
    if (inner === '') return [];
    return inner.split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, ''));
  }
  return trimmed.replace(/^['"]|['"]$/g, '');
}

function parseFrontmatter(content: string): Record<string, unknown> {
  const meta: Record<string, unknown> = {};
  const lines = content.split('\n');
  let inFrontmatter = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '---') {
      if (inFrontmatter) break;
      inFrontmatter = true;
      continue;
    }
    if (!inFrontmatter) continue;
    const m = trimmed.match(LINE_RE);
    if (m) {
      meta[m[1]] = parseValue(m[2]);
    }
  }
  return meta;
}

export function readBacklogTasks(projectRoot: string): BacklogTask[] {
  const tasksDir = path.join(projectRoot, BACKLOG_DIR, TASKS_DIR);
  if (!fs.existsSync(tasksDir)) return [];

  let files: string[];
  try {
    files = fs.readdirSync(tasksDir);
  } catch {
    return [];
  }

  const tasks: BacklogTask[] = [];
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(tasksDir, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }
    const meta = parseFrontmatter(content);
    const id = meta['id'];
    const title = meta['title'];
    const status = meta['status'];
    if (typeof id !== 'string' || typeof title !== 'string' || typeof status !== 'string') continue;

    const assignee = Array.isArray(meta['assignee'])
      ? (meta['assignee'] as string[])
      : (typeof meta['assignee'] === 'string'
          ? [meta['assignee'] as string]
          : []);

    const labels = Array.isArray(meta['labels'])
      ? (meta['labels'] as string[])
      : (typeof meta['labels'] === 'string'
          ? [meta['labels'] as string]
          : []);

    tasks.push({
      id,
      title,
      status,
      assignee,
      labels,
      priority: typeof meta['priority'] === 'string' ? meta['priority'] as string : undefined,
      milestone: typeof meta['milestone'] === 'string' ? meta['milestone'] as string : undefined,
    });
  }

  // Sort by ordinal if available, falling back to id
  const ordinalPriority: Record<string, number> = {};
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    const filePath = path.join(tasksDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const meta = parseFrontmatter(content);
      const id = meta['id'];
      const ordinal = meta['ordinal'];
      if (typeof id === 'string' && typeof ordinal === 'number') {
        ordinalPriority[id] = ordinal;
      }
    } catch {
      // skip
    }
  }

  tasks.sort((a, b) => {
    const oa = ordinalPriority[a.id] ?? 9999;
    const ob = ordinalPriority[b.id] ?? 9999;
    return oa - ob;
  });

  return tasks;
}
