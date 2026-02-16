import React, { useState } from "react";
import { NotificationItem, Workspace, WorkspaceMember, WorkspaceRole } from "../types";
import { Bell, Share2, Users, X } from "lucide-react";

export const WorkspaceSwitcher: React.FC<{
  workspaces: Workspace[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onCreate: (name: string) => Promise<void>;
}> = ({ workspaces, activeId, onSelect, onCreate }) => {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  return (
    <div className="flex items-center gap-2">
      <select
        className="bg-black/40 text-[10px] font-black uppercase tracking-widest text-gray-300 border border-white/10 rounded-lg px-2 py-1.5 outline-none"
        value={activeId || ""}
        onChange={(e) => onSelect(e.target.value)}
      >
        {workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>
      {!creating ? (
        <button onClick={() => setCreating(true)} className="text-[10px] text-violet-400 font-black uppercase tracking-widest">
          New
        </button>
      ) : (
        <div className="flex items-center gap-1">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-28 bg-black/50 border border-white/10 rounded px-2 py-1 text-[10px] text-white outline-none"
            placeholder="Workspace name"
          />
          <button
            className="text-[10px] text-emerald-400 font-black"
            onClick={async () => {
              if (!name.trim()) return;
              await onCreate(name.trim());
              setName("");
              setCreating(false);
            }}
          >
            Save
          </button>
          <button className="text-[10px] text-gray-400 font-black" onClick={() => setCreating(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
};

export const ShareProjectModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  onInvite: (email: string, role: WorkspaceRole) => Promise<void>;
  onCopyReviewLink?: () => Promise<void> | void;
}> = ({ isOpen, onClose, onInvite, onCopyReviewLink }) => {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<WorkspaceRole>("reviewer");
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[350] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-[#111] border border-white/10 rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-white/10 flex items-center justify-between">
          <h3 className="text-white font-black flex items-center gap-2"><Share2 className="w-4 h-4" /> Share Project</h3>
          <button onClick={onClose}><X className="w-4 h-4 text-gray-400" /></button>
        </div>
        <div className="p-4 space-y-3">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="colleague@company.com"
            className="w-full bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none"
          />
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as WorkspaceRole)}
            className="w-full bg-black/50 border border-white/10 rounded-xl px-3 py-2 text-sm text-white outline-none"
          >
            <option value="admin">Admin</option>
            <option value="editor">Editor</option>
            <option value="reviewer">Reviewer</option>
          </select>
          <button
            onClick={async () => {
              await onInvite(email.trim().toLowerCase(), role);
              setEmail("");
            }}
            className="w-full bg-violet-600 hover:bg-violet-500 text-white rounded-xl px-4 py-2 text-sm font-bold"
          >
            Invite Collaborator
          </button>
          {onCopyReviewLink && (
            <button
              onClick={() => onCopyReviewLink()}
              className="w-full bg-white/5 hover:bg-white/10 text-gray-100 rounded-xl px-4 py-2 text-sm font-bold border border-white/10"
            >
              Copy Link to This Review
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export const MembersModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  members: WorkspaceMember[];
  onUpdateRole: (userId: string, role: WorkspaceRole) => Promise<void>;
}> = ({ isOpen, onClose, members, onUpdateRole }) => {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-[350] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-2xl bg-[#111] border border-white/10 rounded-2xl overflow-hidden">
        <div className="p-4 border-b border-white/10 flex items-center justify-between">
          <h3 className="text-white font-black flex items-center gap-2"><Users className="w-4 h-4" /> Members</h3>
          <button onClick={onClose}><X className="w-4 h-4 text-gray-400" /></button>
        </div>
        <div className="p-4 space-y-2 max-h-[60vh] overflow-y-auto">
          {members.map((m) => (
            <div key={m.id} className="bg-black/40 border border-white/10 rounded-xl p-3 flex items-center justify-between">
              <div>
                <div className="text-sm text-white font-bold">{m.email}</div>
                <div className="text-[10px] text-gray-500 uppercase">{m.role}</div>
              </div>
              <select
                value={m.role}
                onChange={async (e) => onUpdateRole(m.userId, e.target.value as WorkspaceRole)}
                className="bg-black/50 border border-white/10 rounded px-2 py-1 text-xs text-white"
              >
                <option value="owner">Owner</option>
                <option value="admin">Admin</option>
                <option value="editor">Editor</option>
                <option value="reviewer">Reviewer</option>
              </select>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export const NotificationsPanel: React.FC<{
  notifications: NotificationItem[];
  onMarkRead: (id: string) => Promise<void>;
}> = ({ notifications, onMarkRead }) => {
  const unread = notifications.filter((n) => !n.read).length;
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen((v) => !v)} className="p-2 bg-white/5 rounded-xl hover:bg-white/10 text-gray-400 transition-colors">
        <Bell className="w-5 h-5" />
        {unread > 0 && <span className="absolute -top-1 -right-1 text-[9px] bg-red-600 text-white rounded-full px-1.5 py-0.5">{unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-[#111] border border-white/10 rounded-xl shadow-2xl z-[400]">
          <div className="p-3 border-b border-white/10 text-xs text-gray-400 uppercase tracking-widest font-black">Notifications</div>
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 && <div className="p-3 text-xs text-gray-500">No notifications</div>}
            {notifications.map((n) => (
              <button key={n.id} onClick={() => onMarkRead(n.id)} className="w-full text-left p-3 border-b border-white/5 hover:bg-white/5">
                <div className={`text-xs ${n.read ? "text-gray-500" : "text-white font-bold"}`}>{n.title}</div>
                <div className="text-[10px] text-gray-500 uppercase mt-1">{n.type}</div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
