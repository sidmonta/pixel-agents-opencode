import type { BacklogTask } from '../hooks/useExtensionMessages.js';
import { Modal } from './ui/Modal.js';

const STATUS_COLUMNS = ['To Do', 'In Progress', 'Done'];

const STATUS_COLORS: Record<string, string> = {
  'To Do': 'border-l-4 border-l-accent',
  'In Progress': 'border-l-4 border-l-yellow-500',
  Done: 'border-l-4 border-l-green-500',
};

interface WhiteboardModalProps {
  isOpen: boolean;
  onClose: () => void;
  tasks: BacklogTask[];
}

function TaskCard({ task }: { task: BacklogTask }) {
  return (
    <div
      className={`bg-bg-surface px-3 py-2 text-sm text-text border-border border shadow-pixel ${STATUS_COLORS[task.status] ?? 'border-l-4 border-l-accent'}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-accent-bright font-bold text-xs shrink-0">{task.id}</span>
        <span className="text-text truncate">{task.title}</span>
      </div>
      {(task.assignee.length > 0 || task.priority) && (
        <div className="flex items-center gap-2 mt-1">
          {task.priority && (
            <span
              className={`text-[10px] px-1.5 py-0.5 leading-none ${
                task.priority === 'high'
                  ? 'bg-red-900 text-red-300'
                  : task.priority === 'medium'
                    ? 'bg-yellow-900 text-yellow-300'
                    : 'bg-gray-700 text-gray-300'
              }`}
            >
              {task.priority}
            </span>
          )}
          {task.assignee.map((a) => (
            <span key={a} className="text-[10px] text-text-muted">
              @{a}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

export function WhiteboardModal({ isOpen, onClose, tasks }: WhiteboardModalProps) {
  const grouped: Record<string, BacklogTask[]> = {};
  for (const col of STATUS_COLUMNS) {
    grouped[col] = tasks.filter((t) => t.status === col);
  }
  const otherStatuses = tasks.filter((t) => !STATUS_COLUMNS.includes(t.status));
  if (otherStatuses.length > 0) {
    grouped['Other'] = otherStatuses;
  }

  const hasTasks = tasks.length > 0;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Whiteboard" className="!w-1/2 !max-w-3xl">
      {!hasTasks ? (
        <div className="flex flex-col items-center justify-center h-80 text-text-muted text-lg">
          <span className="text-5xl mb-4">⬜</span>
          <p>No backlog tasks yet</p>
          <p className="text-sm mt-2">Run <code className="bg-bg-surface px-1">backlog task create</code> to add tasks</p>
        </div>
      ) : (
        <div className="flex gap-4 h-80 overflow-x-auto px-2">
          {Object.entries(grouped).map(([status, columnTasks]) => (
            <div key={status} className="flex flex-col gap-2 min-w-44 flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-accent-bright text-sm font-bold">{status}</span>
                <span className="text-xs text-text-muted">({columnTasks.length})</span>
              </div>
              <div className="flex flex-col gap-2 overflow-y-auto flex-1 pr-1">
                {columnTasks.map((task) => (
                  <TaskCard key={task.id} task={task} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}
