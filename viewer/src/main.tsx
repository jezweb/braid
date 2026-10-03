import { createRoot } from "react-dom/client";
import "./styles.css";
import { captureDemoKey } from "./api";
import { Live } from "./Live";
import { Approve } from "./Approve";
import { Record } from "./Record";
import { useLocation } from "./util";

captureDemoKey();

function App() {
  const loc = useLocation();
  const url = new URL(loc, location.origin);
  const approve = /^\/approve\/(\d+)$/.exec(url.pathname);
  if (approve) return <Approve id={Number(approve[1])} />;
  if (url.pathname === "/record" && url.searchParams.get("path")) {
    const after = url.searchParams.get("after");
    return <Record path={url.searchParams.get("path")!} after={after ? Number(after) : undefined} />;
  }
  return <Live />;
}

createRoot(document.getElementById("root")!).render(<App />);
