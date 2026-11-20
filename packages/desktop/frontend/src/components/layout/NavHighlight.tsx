import { motion } from 'framer-motion';

const EASE = [0.22, 1, 0.36, 1] as const;

/** Shared by the main nav and the conversation list so the selection can slide between them. */
export function NavHighlight({ active }: { active: boolean }) {
	if (!active) return null;
	return (
		<motion.span
			layoutId="tora-nav-highlight"
			aria-hidden
			className="pointer-events-none absolute inset-0 rounded-[10px] bg-sidebar-accent"
			transition={{ layout: { type: 'tween', duration: 0.28, ease: EASE } }}
		/>
	);
}
