import type { ReactElement } from "react";

// What /login and /signup show while the session check runs, instead of a
// blank page: the same small spinner the route fallback uses on light pages.
export default function RedirectSpinner(): ReactElement {
	return (
		<div
			role="status"
			aria-label="Loading page"
			style={{
				minHeight: "100vh",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
				background: "var(--paper)",
			}}
		>
			<div
				className="animate-spin"
				style={{
					width: 28,
					height: 28,
					borderRadius: "50%",
					border: "2px solid rgba(15,23,42,0.12)",
					borderTopColor: "#002d72",
				}}
			/>
		</div>
	);
}
