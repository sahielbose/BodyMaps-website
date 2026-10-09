import { useEffect } from "react";
import { Navigate } from "react-router-dom";
import RedirectSpinner from "../components/RedirectSpinner";
import { useAuth } from "../contexts/authContext";

// /login used to be a page. Signing in is the auth popup now, so this route
// sends you home and opens it, the same way /signup does, so an old link or
// bookmark still lands on the right thing.
export default function LoginRedirect() {
	const { isAuthenticated, loading, promptAuth } = useAuth();

	useEffect(() => {
		// Nothing to open for someone who is already signed in; the redirect
		// below takes them to the app.
		if (!loading && !isAuthenticated) promptAuth("signin");
	}, [loading, isAuthenticated, promptAuth]);

	// Wait for the session check before choosing a destination, so a signed-in
	// visitor isn't bounced to the landing page for a frame.
	if (loading) return <RedirectSpinner />;
	return <Navigate to={isAuthenticated ? "/upload" : "/"} replace />;
}
