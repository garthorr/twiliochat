import { useEffect, useState } from "react";
import { api } from "./api";
import { Login } from "./Login";
import { Messenger } from "./Messenger";

type SessionState = "loading" | "anonymous" | "authenticated";

export function App() {
  const [session, setSession] = useState<SessionState>("loading");

  useEffect(() => {
    api
      .session()
      .then((s) => setSession(s.authenticated ? "authenticated" : "anonymous"))
      .catch(() => setSession("anonymous"));
  }, []);

  if (session === "loading") {
    return <div className="boot" />;
  }
  if (session === "anonymous") {
    return <Login onSuccess={() => setSession("authenticated")} />;
  }
  return <Messenger onLogout={() => setSession("anonymous")} />;
}
