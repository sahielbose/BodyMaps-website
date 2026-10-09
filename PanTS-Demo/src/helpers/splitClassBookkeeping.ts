import type { Color } from "@cornerstonejs/core/types";
import type { CheckBoxData } from "../types";

export type SplitClass = { id: number; label: string; color: Color };
export type ClassTarget = { segment: number | null; catalogOrgan: number | null };

type Setter<T> = (update: (prev: T) => T) => void;

type Deps = {
	setCheckBoxData: Setter<CheckBoxData[]>;
	setCheckState: Setter<boolean[]>;
	setLabelColorMap: Setter<{ [key: number]: Color }>;
	setSegmentColorsHex: Setter<Record<number, string>>;
	setActiveSegment: (id: number | null) => void;
	setActiveCatalogOrgan: (id: number | null) => void;
	// The target as it is now, not as it was when the split ran.
	getTarget: () => ClassTarget;
	colorToHex: (color: Color) => string;
};

/**
 * The page-side half of Split to classes: the rows, colors and target that go
 * with the new classes. Redo adds them back and Undo takes them out, so an
 * undone split leaves no empty Class N rows and no target pointed at one.
 */
export function splitClassBookkeeping(d: Deps, targetBefore: ClassTarget) {
	const add = (created: SplitClass[]) => {
		d.setCheckBoxData((prev) => [
			...prev,
			...created.filter((s) => !prev.some((p) => p.id === s.id)).map((s) => ({ id: s.id, label: s.label })),
		]);
		d.setCheckState((prev) => {
			const next = [...prev];
			for (const s of created) next[s.id] = true;
			return next;
		});
		d.setLabelColorMap((prev) => {
			const next = { ...prev };
			for (const s of created) next[s.id] = s.color;
			return next;
		});
		d.setSegmentColorsHex((prev) => {
			const next = { ...prev };
			for (const s of created) next[s.id] = d.colorToHex(s.color);
			return next;
		});
		// Same "just-created class becomes the target" behavior as
		// handleCreateClass — otherwise the edit target is left pointed at
		// whatever the split just broke apart, which is a confusing thing to
		// keep painting into. Picks the first of the new classes (order matches
		// newLabelForComponent's insertion order on the backend, which isn't
		// otherwise meaningful, but it has to be one of them).
		d.setActiveSegment(created[0].id);
		d.setActiveCatalogOrgan(null);
	};

	const remove = (created: SplitClass[]) => {
		const ids = new Set(created.map((s) => s.id));
		d.setCheckBoxData((prev) => prev.filter((s) => !ids.has(s.id)));
		d.setCheckState((prev) => { const n = [...prev]; for (const id of ids) n[id] = false; return n; });
		d.setLabelColorMap((prev) => { const n = { ...prev }; for (const id of ids) delete n[id]; return n; });
		d.setSegmentColorsHex((prev) => { const n = { ...prev }; for (const id of ids) delete n[id]; return n; });
		// Only move the target back when it is still one of the removed classes;
		// if the person has since picked another class, that pick stays.
		const cur = d.getTarget();
		if (cur.segment != null && ids.has(cur.segment)) {
			d.setActiveSegment(targetBefore.segment);
			d.setActiveCatalogOrgan(targetBefore.catalogOrgan);
		}
	};

	return { add, remove };
}
