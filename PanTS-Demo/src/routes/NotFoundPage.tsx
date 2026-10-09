import { Link } from "react-router";
import Header from "../components/Header";
import SiteFooter from "../components/SiteFooter";
import styles from "./NotFoundPage.module.css";

export default function NotFoundPage() {
  return (
    <div className={styles.page}>
      <Header />
      <main
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.75rem",
          padding: "4rem 1.5rem",
          textAlign: "center",
        }}
      >
        <p
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.875rem",
            color: "var(--muted)",
            margin: 0,
          }}
        >
          404
        </p>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 600, margin: 0, lineHeight: 1.3 }}>
          This page does not exist
        </h1>
        <p style={{ color: "var(--muted)", margin: 0, maxWidth: "28rem" }}>
          The address may be mistyped, or the page may have moved.
        </p>
        <Link to="/" className={styles.home}>
          Back to the overview
        </Link>
      </main>
      <SiteFooter />
    </div>
  );
}
