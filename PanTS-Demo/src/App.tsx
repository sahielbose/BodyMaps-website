import { Suspense, useEffect, useLayoutEffect, type ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation, useNavigate } from "react-router";
import "./App.css";
import { warmCuratedCache } from "./helpers/curatedCache";
import AnalyticsRouteTracker from "./components/AnalyticsRouteTracker";
import AuthModal from "./components/AuthModal";
import ErrorBoundary from "./components/ErrorBoundary";
import MessagePage from "./components/MessagePage";
import { lazyRoute, useRetryFailedRoutesOnNavigation } from "./helpers/lazyRoute";
import { reloadOnceForStaleChunk } from "./helpers/staleChunk";
import { AnnotationProvider } from "./contexts/annotationContexts";
import { AuthProvider } from "./contexts/authContext";
import { FileProvider } from "./contexts/fileContexts";
import LandingPage from "./routes/LandingPage";
import ComparePage from "./routes/ComparePage";
import Homepage from "./routes/Homepage";
import TeamPage from "./routes/TeamPage/index";
import ScrollToTop from "./components/ScrollToTop";
import RouteTitle from "./components/RouteTitle";
import ScrollToTopButton from "./components/ScrollToTopButton";
import { DARK_ROUTE_CLASS, isDarkRoute } from "./helpers/routeSurface";

// The viewer routes pull in the WebGL stack (NiiVue + Cornerstone + three.js), which
// is the bulk of the JS bundle. Code-split them so the landing + dataset pages don't
// download the viewer up front — they only load it when a case is actually opened.
const VisualizationPage = lazyRoute(() => import("./routes/VisualizationPage"));
const CompareViewerPage = lazyRoute(() => import("./routes/CompareViewerPage"));
const UploadPage = lazyRoute(() => import("./routes/UploadPage"));
const LiveRoomPage = lazyRoute(() => import("./liveRooms/LiveRoomPage"));
const SoloChallengePage = lazyRoute(() => import("./education/SoloChallengePage"));
const QuizPracticePage = lazyRoute(() => import("./education/QuizPracticePage"));
const SettingsPage = lazyRoute(() => import("./routes/Settings"));
const ProfileSettings = lazyRoute(() => import("./routes/Settings/ProfileSettings"));
const PlanSettings = lazyRoute(() => import("./routes/Settings/PlanSettings"));
const HistorySettings = lazyRoute(() => import("./routes/Settings/HistorySettings"));
const PrivacySettings = lazyRoute(() => import("./routes/Settings/PrivacySettings"));
// Admin-only sections: split out so the charts and the account list stay out of
// everyone else's bundle.
const AnalyticsSettings = lazyRoute(() => import("./routes/Settings/AnalyticsSettings"));
const PeopleSettings = lazyRoute(() => import("./routes/Settings/PeopleSettings"));
const SignupRedirect = lazyRoute(() => import("./routes/SignupRedirect"));
const LoginRedirect = lazyRoute(() => import("./routes/LoginRedirect"));
const ResetPassword = lazyRoute(() => import("./routes/ResetPassword"));
const VerifyEmail = lazyRoute(() => import("./routes/VerifyEmail"));
const LegalPage = lazyRoute(() => import("./routes/LegalPage"));
const SharePatientCard = lazyRoute(() => import("./routes/SharePatientCard"));
const NotFoundPage = lazyRoute(() => import("./routes/NotFoundPage"));

const BASENAME = import.meta.env.VITE_BASENAME;

// Lightweight fallback shown while a lazy route chunk loads (intentionally avoids the
// three.js loader so the fallback itself stays out of the main bundle). It paints
// in the colour of the page that is coming, so a direct load of a light page no
// longer flashes a black screen first.
function RouteFallback() {
  const dark = isDarkRoute(useLocation().pathname);
  return (
    <div
      role="status"
      aria-label="Loading page"
      className="route-fallback"
      style={{
        background: dark ? "#08090b" : "var(--paper)",
      }}
    >
      <div
        className="animate-spin"
        style={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          border: dark ? "2px solid rgba(255,255,255,0.15)" : "2px solid rgba(15,23,42,0.12)",
          borderTopColor: dark ? "rgba(255,255,255,0.6)" : "#002d72",
        }}
      />
    </div>
  );
}

// Keeps the <html> class that paints the dark routes' body in step with the
// route. index.html sets it before the first paint on a hard load; this
// follows in-app navigation, so overscroll and any gap below a page show the
// page's own colour.
function RouteSurface() {
  const { pathname } = useLocation();
  useLayoutEffect(() => {
    document.documentElement.classList.toggle(DARK_ROUTE_CLASS, isDarkRoute(pathname));
  }, [pathname]);
  return null;
}

// First Tab stop on every page: a visually hidden link that shows on focus and
// hands focus to the page's main landmark, past the header. It moves focus
// itself rather than following a "#id" link, which would rewrite the URL under
// the router's basename, and on a live room page would replace the secret key
// in the URL fragment. The click is always cancelled, so pages without a <main>
// (a blank route fallback) do nothing.
function SkipLink() {
  return (
    <a
      className="skip-link"
      href="#main"
      onClick={(event) => {
        event.preventDefault();
        const main = document.querySelector<HTMLElement>("main");
        if (!main) return;
        if (!main.hasAttribute("tabindex")) main.setAttribute("tabindex", "-1");
        main.focus();
      }}
    >
      Skip to main content
    </a>
  );
}

// A route that throws while rendering, or whose chunk fails to load (offline, or
// a new build replaced the old files under an open tab), shows this page with
// the site header instead of unmounting the whole app to a blank screen. It
// retries on every navigation, including a link to the path it is already on
// (the location key changes even when the path does not), so the header links
// and "Back to the overview" still work from an error page at "/".
// "Try again" retries inside the app while offline, by navigating to the current
// URL: that changes the location key, so the boundary resets and a failed chunk
// is fetched again. A full reload would swap the open page for the browser's own
// offline page when the network is down, so the reload is kept while online (it
// also picks up a new build that replaced the files under an open tab). The
// retry marks its location, so the error page that comes back after a failed
// retry takes keyboard focus on its heading instead of dropping it to the page.
function RouteErrorPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const retried = (location.state as { tryAgain?: boolean } | null)?.tryAgain === true;
  useEffect(() => {
    if (!retried) return;
    const heading = document.querySelector<HTMLElement>("main h1");
    if (!heading) return;
    if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
    heading.focus();
  }, [retried]);
  const tryAgain = () => {
    if (navigator.onLine !== false) window.location.reload();
    else {
      const state = typeof location.state === "object" ? location.state : null;
      navigate(location.pathname + location.search + location.hash, {
        replace: true,
        state: { ...state, tryAgain: true },
      });
    }
  };
  return (
    <MessagePage
      title="This page could not load"
      alert
      actions={[
        { label: "Try again", onClick: tryAgain },
        { label: "Back to the overview", to: "/" },
      ]}
    >
      Check your connection and try again.
    </MessagePage>
  );
}

function RouteErrorBoundary({ children }: { children: ReactNode }) {
  useRetryFailedRoutesOnNavigation();
  return (
    <ErrorBoundary resetKey={useLocation().key} fallback={<RouteErrorPage />}>
      {children}
    </ErrorBoundary>
  );
}

function App() {
  // Warm the Dataset landing grid shortly after boot (when the main thread is
  // idle), so tab-switching to Dataset from any page renders from cache instead
  // of fetching search + thumbnails on the click.
  useEffect(() => {
    const w = window as unknown as {
      requestIdleCallback?: (cb: () => void) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    const ric = w.requestIdleCallback;
    const id = ric
      ? ric(() => warmCuratedCache())
      : window.setTimeout(warmCuratedCache, 1200);
    return () => {
      if (ric) w.cancelIdleCallback?.(id as number);
      else window.clearTimeout(id as number);
    };
  }, []);

  // A chunk that 404s after a deploy: reload once so the tab picks up the new
  // build by itself. If the reload does not fix it the route boundary shows.
  useEffect(() => {
    const onPreloadError = (event: Event) => reloadOnceForStaleChunk(event);
    window.addEventListener("vite:preloadError", onPreloadError);
    return () => window.removeEventListener("vite:preloadError", onPreloadError);
  }, []);

  return (
    <AuthProvider>
      <FileProvider>
        <AnnotationProvider>
          <div className="App">
            <SkipLink />
            <BrowserRouter basename={BASENAME} useTransitions={false}>
              <AnalyticsRouteTracker />
              <ScrollToTop />
              <RouteTitle />
              <RouteSurface />
              <RouteErrorBoundary>
              <Suspense fallback={<RouteFallback />}>
                <Routes>
                  <Route path="/" element={<LandingPage />} />
                  <Route
                    path="/home.html"
                    element={<Navigate to="/" replace />}
                  />
                  <Route path="/dashboard" element={<Homepage />} />
                  <Route path="/case/:caseId" element={<VisualizationPage />} />
                  <Route path="/live/:roomId" element={<LiveRoomPage />} />
                  <Route path="/live/challenge/:challengeId" element={<SoloChallengePage />} />
                  <Route path="/learn/quiz/:packId" element={<QuizPracticePage />} />
                  <Route path="/share/:shareId" element={<SharePatientCard />} />
                  <Route
                    path="/session/:sessionId"
                    element={<VisualizationPage />}
                  />
                  {/* Local DICOM series picked on the Upload page (files held in memory). */}
                  <Route path="/dicom" element={<VisualizationPage />} />
                  {/* Local NIfTI picked on the Upload page (file held in memory). */}
                  <Route path="/local-nifti" element={<VisualizationPage />} />
                  <Route
                    path="/reconstruction/:reconstructionId"
                    element={<VisualizationPage />}
                  />
                  <Route path="/upload" element={<UploadPage />} />
                  {/* Both sign in and sign up are the popup now. /login and
                      /signup stay routable so old links don't 404. */}
                  <Route path="/login" element={<LoginRedirect />} />
                  <Route path="/signup" element={<SignupRedirect />} />
                  {/* Where the emailed reset link lands. Public by necessity —
                      the person following it can't sign in. */}
                  <Route path="/reset-password" element={<ResetPassword />} />
                  {/* Where the emailed verification link lands. Public for the
                      same reason. */}
                  <Route path="/verify-email" element={<VerifyEmail />} />
                  {/* Settings is a shell with a left nav; each section is its
                      own URL so a link can point straight at one. */}
                  <Route path="/account" element={<SettingsPage />}>
                    <Route index element={<ProfileSettings />} />
                    <Route path="plan" element={<PlanSettings />} />
                    <Route path="history" element={<HistorySettings />} />
                    <Route path="privacy" element={<PrivacySettings />} />
                    {/* Admin-only. Both check the role themselves and the API
                        refuses either way — the nav just doesn't offer them. */}
                    <Route path="analytics" element={<AnalyticsSettings />} />
                    <Route path="people" element={<PeopleSettings />} />
                  </Route>
                  <Route path="/terms" element={<LegalPage kind="terms" />} />
                  <Route path="/privacy" element={<LegalPage kind="privacy" />} />
                  <Route
                    path="/api"
                    element={<Navigate to="/upload" replace />}
                  />
                  <Route path="/team" element={<TeamPage />} />
                  <Route path="/compare" element={<ComparePage />} />
                  <Route
                    path="/compare-viewer"
                    element={<CompareViewerPage />}
                  />
                  {/* Unknown URLs land here instead of an empty page. */}
                  <Route path="*" element={<NotFoundPage />} />
                </Routes>
              </Suspense>
              </RouteErrorBoundary>
              {/* After the page, so it is the last stop in the tab order rather
                  than the first (it only takes focus while it is showing). */}
              <ScrollToTopButton />
              {/* Global auth popup, above all routes. Inside the router so it
                  can link to the legal pages. */}
              <AuthModal />
            </BrowserRouter>
          </div>
        </AnnotationProvider>
      </FileProvider>
    </AuthProvider>
  );
}

export default App;
