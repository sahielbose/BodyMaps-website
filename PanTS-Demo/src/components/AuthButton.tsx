// The account control shown in both nav bars (LandingPage's inline nav and the
// shared Header). Signed out: a "Sign in" button that opens the auth popup.
// Signed in: an account menu (the name they set, or their email until they set
// one, + dropdown: Account settings, Sign out).
// Reads authContext, so it flips everywhere at once.
//
// The dropdown is a disclosure (a button that shows and hides a short list of
// buttons), not an ARIA menu: Tab moves through it, Escape closes it and puts
// focus back on the trigger, and it closes when focus or a click leaves it.
import { IconChevronDown, IconLogout, IconSettings } from "@tabler/icons-react";
import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../contexts/authContext";
import { nameInitial } from "../liveRooms/composerHelpers";
import styles from "./AuthButton.module.css";

interface AuthButtonProps {
	/** Runs before the control acts (opening sign-in, a menu item), so a
	 *  container such as the mobile nav drawer can close first. */
	onAction?: () => void;
	/** Open the dropdown above the trigger rather than below it: the mobile
	 *  drawer pins the control to the bottom of the screen. */
	dropUp?: boolean;
}

export default function AuthButton({ onAction, dropUp = false }: AuthButtonProps = {}) {
	const { user, isAuthenticated, loading, signOut, promptAuth, authPrompt } = useAuth();
	const navigate = useNavigate();
	const [menuOpen, setMenuOpen] = useState(false);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const menuId = useId();
	const wasAuthenticated = useRef(isAuthenticated);
	const signedInFromPopup = useRef(false);
	const signInRef = useRef<HTMLButtonElement | null>(null);
	const signedOutFromMenu = useRef(false);

	// Signing in from the popup swaps the Sign in button (the popup's opener) for
	// this account trigger, so the dialog has nowhere to return focus to and it
	// would fall to the page. Once the popup has closed, put it on the trigger.
	useEffect(() => {
		if (isAuthenticated && !wasAuthenticated.current && authPrompt.open) signedInFromPopup.current = true;
		wasAuthenticated.current = isAuthenticated;
		if (!signedInFromPopup.current || authPrompt.open) return;
		signedInFromPopup.current = false;
		const active = document.activeElement;
		if (!active || active === document.body) triggerRef.current?.focus({ preventScroll: true });
	}, [isAuthenticated, authPrompt.open]);

	// Signing out from the menu removes the focused menu item and swaps the
	// account trigger for the Sign in button, so focus would fall to the page.
	// Put it on the new Sign in button.
	useEffect(() => {
		if (isAuthenticated || !signedOutFromMenu.current) return;
		signedOutFromMenu.current = false;
		const active = document.activeElement;
		if (!active || active === document.body) signInRef.current?.focus({ preventScroll: true });
	}, [isAuthenticated]);

	// The session can end while the dropdown is open (signed out in another tab).
	// The outside-click handler cannot close it then, since the root is gone, so
	// it would be open again over the page after the next sign-in.
	useEffect(() => {
		if (!isAuthenticated) setMenuOpen(false);
	}, [isAuthenticated]);

	// Close the dropdown on any outside click.
	useEffect(() => {
		if (!menuOpen) return;
		const onDown = (e: MouseEvent) => {
			if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
			}
		};
		document.addEventListener("mousedown", onDown);
		return () => document.removeEventListener("mousedown", onDown);
	}, [menuOpen]);

	// Until the initial /me check resolves, hold the Sign in button's exact
	// footprint (same class, same text, invisible) instead of rendering
	// nothing, so the nav does not shift when the real control arrives.
	if (loading) {
		return (
			<span
				className={`${styles.signInBtn} ${styles.placeholder}`}
				aria-hidden="true"
				data-auth-placeholder=""
			>
				Sign in
			</span>
		);
	}

	if (!isAuthenticated || !user) {
		return (
			<button
				ref={signInRef}
				type="button"
				className={styles.signInBtn}
				onClick={() => {
					onAction?.();
					promptAuth();
				}}
			>
				Sign in
			</button>
		);
	}

	const initial = nameInitial(user.name || user.email);

	const onMenuKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
		if (e.key === "Escape" && menuOpen) {
			e.stopPropagation();
			setMenuOpen(false);
			triggerRef.current?.focus();
		}
	};

	// Tabbing out of the control closes the dropdown behind it. Only when focus
	// lands somewhere else: a click (which some browsers do not focus) is the
	// mousedown handler's job, and closing here would swallow it.
	const onBlur = (e: FocusEvent<HTMLDivElement>) => {
		const next = e.relatedTarget as Node | null;
		if (menuOpen && next && !rootRef.current?.contains(next)) {
			setMenuOpen(false);
		}
	};

	return (
		<div className={`${styles.accountRoot} ${dropUp ? styles.inDrawer : ""}`} ref={rootRef} onKeyDown={onMenuKeyDown} onBlur={onBlur}>
			<button
				ref={triggerRef}
				type="button"
				className={styles.accountTrigger}
				onClick={() => setMenuOpen((o) => !o)}
				aria-expanded={menuOpen}
				aria-controls={menuOpen ? menuId : undefined}
				aria-label={user.hasCustomName ? user.name : user.email}
			>
				<span className={styles.avatar} aria-hidden="true">{initial}</span>
				<span className={styles.accountEmail}>
					{user.hasCustomName ? user.name : user.email}
				</span>
				<IconChevronDown size={15} className={styles.chevron} aria-hidden="true" />
			</button>

			{menuOpen && (
				<div className={`${styles.menu} ${dropUp ? styles.menuUp : ""}`} id={menuId}>
					<div className={styles.menuHeader}>
						<div className={styles.menuName}>{user.name}</div>
						<div className={styles.menuEmail}>{user.email}</div>
					</div>
					<button
						type="button"
						className={styles.menuItem}
						onClick={() => {
							setMenuOpen(false);
							onAction?.();
							navigate("/account");
						}}
					>
						<IconSettings size={16} aria-hidden="true" />
						Account settings
					</button>
					<button
						type="button"
						className={styles.menuItem}
						onClick={() => {
							setMenuOpen(false);
							onAction?.();
							signedOutFromMenu.current = true;
							signOut();
							navigate("/");
						}}
					>
						<IconLogout size={16} aria-hidden="true" />
						Sign out
					</button>
				</div>
			)}
		</div>
	);
}
