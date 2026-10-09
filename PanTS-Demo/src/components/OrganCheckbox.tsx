import type { Color } from "@cornerstonejs/core/types";
import { IconCheck, IconChevronRight, IconCurrentLocation, IconMinus } from "@tabler/icons-react";
import React, { useId, useState } from "react";
import {
	MiscColorMap, OrganSystems,
	OrganSystemsArray,
	segmentation_categories
} from "../helpers/constants";
import { classInSentence, filenameToName, midSentence } from "../helpers/utils.name";
import PanelHeader from "./PanelHeader";
import {
	type AllSystems,
	type OrganSystemsAllType,
	type SubSystems,
	type Systems,
	type CheckBoxData
} from "../types";

type ChipBoxProps = {
	labelColorMap: { [key: number]: number[] };
	system: AllSystems;
	setCheckState: React.Dispatch<React.SetStateAction<boolean[]>>;
	checkState: boolean[];
	level: number;
	OrganSystem: OrganSystemsAllType;
	onJumpToOrgan?: (label: number) => void;
};

type Props = {
	labelColorMap: { [key: number]: Color };
	setCheckState: React.Dispatch<React.SetStateAction<boolean[]>>;
	checkState: boolean[];
	sessionId: string | undefined;
	setShowOrganDetails: React.Dispatch<React.SetStateAction<boolean>>;
	showOrganDetails: boolean;
	onJumpToOrgan?: (label: number) => void;
	customOrgans?: CheckBoxData[];
};

const getOrganIdx = (organ: string) => {
	for (let i = 0; i < segmentation_categories.length; i++) {
		if (segmentation_categories[i] === organ) {
			return i;
		}
	}
	return 0;
};

/** checkState slots (label index + 1) of every organ under `system`,
 *  including the organs of its sub-groups (Kidneys, Pancreas, Colon). */
export function systemOrganSlots(OrganSystem: OrganSystemsAllType, system: AllSystems): number[] {
	const slots: number[] = [];
	for (const sub of OrganSystem[system] ?? []) {
		if (typeof sub === "string") {
			slots.push(getOrganIdx(sub) + 1);
			continue;
		}
		const key = Object.keys(sub)[0] as SubSystems;
		for (const organ of sub[key] ?? []) slots.push(getOrganIdx(organ) + 1);
	}
	return slots;
}

/** A group checkbox's state: checked when every organ in it is shown,
 *  unchecked when none is, mixed otherwise. */
export function groupCheckState(slots: number[], checkState: boolean[]): boolean | "mixed" {
	const shown = slots.filter((i) => checkState[i] === true).length;
	if (shown === 0) return false;
	return shown === slots.length ? true : "mixed";
}

/** "Urinary System" -> "Urinary system": the system keys stay as they are
 *  (they index OrganSystems), only the label is sentence case. */
const systemLabel = (system: AllSystems) =>
	system.charAt(0) + system.slice(1).toLowerCase();

const rgbOf = (color: ArrayLike<number> | undefined) =>
	color ? `rgb(${color[0]}, ${color[1]}, ${color[2]})` : "gray";

/** One organ as a checkbox button. Its colour ring shows it is visible; the
 *  ring is a box-shadow, so toggling or hovering never changes its size. */
function OrganRow({
	label,
	color,
	checked,
	onToggle,
	onJump,
	indentClass,
}: {
	label: string;
	color: string;
	checked: boolean;
	onToggle: () => void;
	onJump?: () => void;
	indentClass: string;
}) {
	return (
		<div className={`vp-organs__row flex items-center gap-2 ${indentClass}`}>
			<button
				type="button"
				role="checkbox"
				aria-checked={checked}
				className="vp-organs__item"
				style={{ "--organ-color": color } as React.CSSProperties}
				onClick={onToggle}
			>
				{label}
			</button>
			{onJump && (
				<button
					type="button"
					className="vp-organs__jump"
					title={`Jump to ${classInSentence(label)}`}
					aria-label={`Jump to ${classInSentence(label)}`}
					onClick={(e) => {
						e.stopPropagation();
						onJump();
					}}
				>
					<IconCurrentLocation size={15} />
				</button>
			)}
		</div>
	);
}

function Checked({
	OrganSystem,
	system,
	labelColorMap,
	checkState,
	setCheckState,
	level = 0,
	onJumpToOrgan,
}: ChipBoxProps) {
	const [expanded, setExpanded] = useState(false);
	const listId = useId();

	if (!OrganSystem[system] || level > 1) return null;

	// Derived on every render from all nested organs, so a system reads as
	// mixed while only a sub-group organ (kidney left, colon lesion) is shown.
	const slots = systemOrganSlots(OrganSystem, system);
	const state = groupCheckState(slots, checkState);
	// A mixed or unchecked group turns everything on; a fully checked one
	// turns everything off.
	const toggleGroup = () => {
		const show = state !== true;
		setCheckState((prev) => {
			if (slots.every((i) => prev[i] === show)) return prev;
			const next = [...prev];
			for (const i of slots) next[i] = show;
			return next;
		});
	};
	const toggleOrgan = (slot: number) => {
		setCheckState((prev) => {
			const next = [...prev];
			next[slot] = !next[slot];
			return next;
		});
	};

	const chipColor = system in MiscColorMap ? rgbOf(MiscColorMap[system as SubSystems]) : null;
	const name = systemLabel(system);

	return (
		<div className={`flex gap-2 flex-col ${level === 0 ? "" : "vp-organs__sub"}`}>
			<div className="flex justify-between items-center gap-2">
				{!chipColor ? (
					<>
						<button
							type="button"
							className="vp-organs__disclosure"
							aria-expanded={expanded}
							aria-controls={listId}
							onClick={() => setExpanded((prev) => !prev)}
						>
							<IconChevronRight
								aria-hidden="true"
								className={`vp-organs__chevron ${expanded ? "is-open" : ""}`}
							/>
							<span className="vp-organs__system">{name}</span>
						</button>
						<button
							type="button"
							role="checkbox"
							aria-checked={state}
							aria-label={`Show ${midSentence(name)}`}
							className={`vp-checkbox ${state !== false ? "vp-checkbox--on" : ""}`}
							onClick={toggleGroup}
						>
							{state === true && <IconCheck size={13} stroke={3} />}
							{state === "mixed" && <IconMinus size={13} stroke={3} />}
						</button>
					</>
				) : (
					<div className="flex items-center gap-1">
						<button
							type="button"
							className="vp-organs__disclosure"
							aria-expanded={expanded}
							aria-controls={listId}
							aria-label={`${name} organs`}
							onClick={() => setExpanded((prev) => !prev)}
						>
							<IconChevronRight
								aria-hidden="true"
								className={`vp-organs__chevron ${expanded ? "is-open" : ""}`}
							/>
						</button>
						<button
							type="button"
							role="checkbox"
							aria-checked={state}
							className="vp-organs__item vp-organs__item--group"
							style={{ "--organ-color": chipColor } as React.CSSProperties}
							onClick={toggleGroup}
						>
							{name}
						</button>
					</div>
				)}
			</div>
			{/* Collapsed groups are hidden outright, so their rows leave the tab
			    order; the sub-groups inside keep their own open state. */}
			<div id={listId} className="vp-organs__group-list" hidden={!expanded}>
				{OrganSystem[system].map((organ, idx) => {
					if (typeof organ === "string") {
						// A subgroup's header (Pancreas, Colon) already toggles the organ
						// of the same name, so it isn't repeated as a child row.
						if (level === 1 && organ === system.toLowerCase()) return null;
						const slot = getOrganIdx(organ) + 1;
						return (
							<OrganRow
								key={idx}
								label={filenameToName(organ)}
								color={rgbOf(labelColorMap[slot])}
								checked={checkState[slot] === true}
								onToggle={() => toggleOrgan(slot)}
								onJump={onJumpToOrgan ? () => onJumpToOrgan(slot) : undefined}
								indentClass={level == 0 ? "vp-organs__row--l0" : "vp-organs__row--l1"}
							/>
						);
					} else if (
						typeof organ === "object" &&
						Object.keys(organ).length === 1
					) {
						const organKey: AllSystems = Object.keys(organ)[0] as AllSystems;
						return (
							<Checked
								key={organKey}
								OrganSystem={organ}
								system={organKey}
								labelColorMap={labelColorMap}
								checkState={checkState}
								setCheckState={setCheckState}
								level={level + 1}
								onJumpToOrgan={onJumpToOrgan}
							/>
						);
					}
					return null;
				})}
			</div>
		</div>
	);
}

function OrganCheckbox({
	setCheckState,
	checkState,
	labelColorMap,
	setShowOrganDetails,
	showOrganDetails,
	onJumpToOrgan,
	customOrgans = [],
}: Props) {
	const titleId = useId();
	const toggleAll = () => {
		setCheckState((prev) => {
			let newState = [...prev];
			const trueCount = newState.filter((val) => val === true).length;
			if (trueCount > newState.length / 2) {
				newState = newState.map(() => false);
			} else {
				newState = newState.map(() => true);
			}
			return newState;
		});
	};

	// Docked in the viewer's body row (left of the stage), not a fixed overlay
	// (on a phone it floats over the stage instead, see VisualizationPage.css).
	// Kept mounted with display toggled so the expand/collapse state survives.
	return (
		<div
			className={`vp-organs flex-col ${
				showOrganDetails ? "vp-organs--open" : ""
			}`}
			role="region"
			aria-labelledby={titleId}
		>
			<PanelHeader
				title="Organs"
				titleId={titleId}
				closeLabel="Close organs panel"
				onClose={() => setShowOrganDetails(false)}
			>
				<button type="button" className="vp-panel-head__chip" onClick={() => toggleAll()}>
					Toggle all
				</button>
			</PanelHeader>
			<div className="vp-organs__list flex flex-col gap-1 overflow-y-auto">
				{OrganSystemsArray.map((system: Systems, idx) => {
					return (
						<Checked
							level={0}
							OrganSystem={OrganSystems}
							key={idx}
							system={system}
							labelColorMap={labelColorMap}
							checkState={checkState}
							setCheckState={setCheckState}
							onJumpToOrgan={onJumpToOrgan}
						/>
					);
				})}
				{/* Inside the scroller, so many custom classes scroll with the organs instead of squeezing the list. */}
				{customOrgans.length > 0 && (
					<div className="flex gap-2 flex-col pt-2">
						<div className="text-white text-lg">Custom classes</div>
						<div className="flex flex-col gap-2">
							{customOrgans.map((organ) => (
								<OrganRow
									key={organ.id}
									label={organ.label}
									color={rgbOf(labelColorMap[organ.id])}
									checked={checkState[organ.id] === true}
									onToggle={() => {
										setCheckState((prev) => {
											const newCheckState = [...prev];
											newCheckState[organ.id] = !newCheckState[organ.id];
											return newCheckState;
										});
									}}
									onJump={onJumpToOrgan ? () => onJumpToOrgan(organ.id) : undefined}
									indentClass="vp-organs__row--l0"
								/>
							))}
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
export default OrganCheckbox;
