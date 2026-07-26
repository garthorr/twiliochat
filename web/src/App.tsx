import { useEffect, useState } from "react";
import { api } from "./api";
import { Login } from "./Login";
import { Messenger } from "./Messenger";

type SessionState = "loading" | "anonymous" | "authenticated";

// Remembers the last known result of the session check so an offline launch
// can render cached history instead of bouncing to the login screen. The real
// authorization check is server-side; this only decides which screen to show.
const SESSION_HINT_KEY = "twiliochat:signed-in";

export function App() {
  const [session, setSession] = useState<SessionState>("loading");

  useEffect(() => {
    api
      .session()
      .then((s) => {
        localStorage.setItem(SESSION_HINT_KEY, s.authenticated ? "1" : "0");
        setSession(s.authenticated ? "authenticated" : "anonymous");
      })
      .catch(() => {
        // Offline or server unreachable: trust the last known state.
        setSession(
          localStorage.getItem(SESSION_HINT_KEY) === "1"
            ? "authenticated"
            : "anonymous",
        );
      });
  }, []);

  if (session === "loading") {
    return <div className="boot" />;
  }
  if (session === "anonymous") {
    return (
      <Login
        onSuccess={() => {
          localStorage.setItem(SESSION_HINT_KEY, "1");
          setSession("authenticated");
        }}
      />
    );
  }
  return (
    <Messenger
      onLogout={() => {
        localStorage.setItem(SESSION_HINT_KEY, "0");
        setSession("anonymous");
      }}
    />
  );
}
