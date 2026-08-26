import { lazy, Suspense, useEffect } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import "./App.css";
import { warmCuratedCache } from "./helpers/curatedCache";
import AnalyticsRouteTracker from "./components/AnalyticsRouteTracker";
import AuthModal from "./components/AuthModal";
import { AnnotationProvider } from "./contexts/annotationContexts";
import { AuthProvider } from "./contexts/authContext";
import { FileProvider } from "./contexts/fileContexts";
import LandingPage from "./routes/LandingPage";
import ComparePage from "./routes/ComparePage";
import Homepage from "./routes/Homepage";
import TeamPage from "./routes/TeamPage/index";
import ScrollToTopButton from "./components/ScrollToTopButton";

// The viewer routes pull in the WebGL stack (NiiVue + Cornerstone + three.js), which
// is the bulk of the JS bundle. Code-split them so the landing + dataset pages don't
// download the viewer up front — they only load it when a case is actually opened.
const VisualizationPage = lazy(() => import("./routes/VisualizationPage"));
const CompareViewerPage = lazy(() => import("./routes/CompareViewerPage"));
const UploadPage = lazy(() => import("./routes/UploadPage"));
const LiveRoomPage = lazy(() => import("./liveRooms/LiveRoomPage"));
const SoloChallengePage = lazy(() => import("./education/SoloChallengePage"));
const QuizPracticePage = lazy(() => import("./education/QuizPracticePage"));
const SettingsPage = lazy(() => import("./routes/Settings"));
const ProfileSettings = lazy(() => import("./routes/Settings/ProfileSettings"));
const PlanSettings = lazy(() => import("./routes/Settings/PlanSettings"));
const HistorySettings = lazy(() => import("./routes/Settings/HistorySettings"));
const PrivacySettings = lazy(() => import("./routes/Settings/PrivacySettings"));
// Admin-only sections: split out so the charts and the account list stay out of
// everyone else's bundle.
const AnalyticsSettings = lazy(() => import("./routes/Settings/AnalyticsSettings"));
const PeopleSettings = lazy(() => import("./routes/Settings/PeopleSettings"));
const SignupRedirect = lazy(() => import("./routes/SignupRedirect"));
const ResetPassword = lazy(() => import("./routes/ResetPassword"));
const LegalPage = lazy(() => import("./routes/LegalPage"));
const SharePatientCard = lazy(() => import("./routes/SharePatientCard"));
const NotFoundPage = lazy(() => import("./routes/NotFoundPage"));

const BASENAME = import.meta.env.VITE_BASENAME;

// Lightweight fallback shown while a lazy route chunk loads (intentionally avoids the
// three.js loader so the fallback itself stays out of the main bundle).
function RouteFallback() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#08090b",
      }}
    >
      <div
        className="animate-spin"
        style={{
          width: 28,
          height: 28,
          borderRadius: "50%",
          border: "2px solid rgba(255,255,255,0.15)",
          borderTopColor: "rgba(255,255,255,0.6)",
        }}
      />
    </div>
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

  return (
    <AuthProvider>
      <FileProvider>
        <AnnotationProvider>
          <div className="App">
            <BrowserRouter basename={BASENAME}>
              <AnalyticsRouteTracker />
              <ScrollToTopButton />
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
                  <Route path="/login" element={<Navigate to="/" replace />} />
                  <Route path="/signup" element={<SignupRedirect />} />
                  {/* Where the emailed reset link lands. Public by necessity —
                      the person following it can't sign in. */}
                  <Route path="/reset-password" element={<ResetPassword />} />
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
