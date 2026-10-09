// helpers/motion.ts
//
// prefers-reduced-motion for motion started from JavaScript. CSS motion is
// covered by the global rule in index.css; smooth scrolls and JS-driven
// animations have to ask here.

export function prefersReducedMotion(): boolean {
	return typeof window !== "undefined"
		&& typeof window.matchMedia === "function"
		&& window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** "smooth" unless the visitor asked for reduced motion. */
export function scrollBehavior(): ScrollBehavior {
	return prefersReducedMotion() ? "auto" : "smooth";
}
