import { createContext, useContext } from "react";

// Shared busy/notice state for the settings sections, so every action reports
// success and failure through the one banner in the shell.
//
// Its own file rather than living in index.tsx: exporting a hook next to a
// component breaks fast refresh for the whole module.

export type SettingsContextValue = {
	busy: boolean;
	/**
	 * Runs an action, reporting failure in the shared banner. `scope` names what
	 * the action saves, so a queued retry of the same thing can clear the error
	 * the earlier try left behind.
	 */
	run: (fn: () => Promise<void>, scope?: string) => Promise<void>;
	notify: (message: string) => void;
	fail: (message: string) => void;
};

export const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
	const ctx = useContext(SettingsContext);
	if (!ctx) throw new Error("useSettings must be used within the settings shell");
	return ctx;
}
