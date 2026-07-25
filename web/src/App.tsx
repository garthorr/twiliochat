import { useEffect, useState } from "react";

type Health = { status: string; db: string } | null;

export function App() {
  const [health, setHealth] = useState<Health>(null);

  useEffect(() => {
    fetch("/healthz")
      .then((r) => r.json())
      .then(setHealth)
      .catch(() => setHealth({ status: "unreachable", db: "unknown" }));
  }, []);

  return (
    <div className="app">
      <aside className="sidebar">
        <header className="sidebar-header">
          <h1>Messages</h1>
        </header>
        <input className="search" type="search" placeholder="Search" />
        <div className="conversation-list">
          <p className="empty-hint">No conversations yet</p>
        </div>
      </aside>
      <main className="thread">
        <div className="thread-empty">
          <p className="thread-empty-title">TwilioChat</p>
          <p className="thread-empty-sub">
            {health
              ? `Server: ${health.status} · DB: ${health.db}`
              : "Connecting…"}
          </p>
        </div>
      </main>
    </div>
  );
}
