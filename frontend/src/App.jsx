import { useEffect, useMemo, useRef, useState } from 'react';
import Header from './components/Header';
import TripPlanningSection from './components/TripPlanningSection';
import RealRouteSection from './components/RealRouteSection';
import CurrentWeatherSection from './components/CurrentWeatherSection';
import RouteSelectionArea from './components/RouteSelectionArea';
import ScenarioSimulationSection from './components/ScenarioSimulationSection';
import CctvInvestigationSection from './components/CctvInvestigationSection';
import AIAssistantSection from './components/AIAssistantSection';
import MapView from './components/MapView';
import SystemPipelineSection from './components/SystemPipelineSection';
import ProvenanceLegend from './components/ProvenanceLegend';
import OverviewSection from './components/OverviewSection';
import TrafficSection from './components/TrafficSection';
import WeatherSection from './components/WeatherSection';
import RoadConditionSection from './components/RoadConditionSection';
import RoadScoreSection from './components/RoadScoreSection';
import ProvenanceSection from './components/ProvenanceSection';
import DataFooter from './components/DataFooter';
import StatusBadge from './components/StatusBadge';
import RouteReasoningPanel from './components/RouteReasoningPanel';
import RecordedVideoEvidenceSection from './components/RecordedVideoEvidenceSection';
import {
  createLocationService,
  errorKindFor,
} from './services/locationProviders';
import {
  createWeatherService,
  weatherErrorKindFor,
} from './services/weatherProvider';
import { createAssistantService } from './services/aiAssistant';
import { createVoiceAssistantService } from './services/voiceAssistant';
import { createLocationProvider, locationCard } from './services/geolocation';
import { createTripService } from './services/tripService';
import { scenarioUiState } from './services/scenarioSimulator';
import {
  tripInvestigationState,
  routeCandidates,
  tripStage,
} from './services/controlCenter';
import {
  getRoutes,
  getTraffic,
  getLevel8,
  getRoadConditions,
  getDemoCctvEvidence,
} from './services/dataService';

const locationService = createLocationService();
const weatherService = createWeatherService();
const voiceService = createVoiceAssistantService();
const locationProvider = createLocationProvider();

// Prepared evidence used by the route-intelligence layer (read-only copies).
const routeIntelligenceEvidence = {
  trafficOverview: getTraffic().overview,
  classByVideo: getLevel8().classByVideo,
  roadRows: getRoadConditions().rows,
  demoCctvEvidence: getDemoCctvEvidence(),
};
const tripService = createTripService({ locationService, evidence: routeIntelligenceEvidence });

export default function App() {
  const [view, setView] = useState('home');
  const viewStackRef = useRef([]);
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [originFromLocation, setOriginFromLocation] = useState(false);
  const [location, setLocation] = useState({ status: 'idle', coords: null, source: null });
  const [trip, setTrip] = useState(null);
  const [selectedRouteId, setSelectedRouteId] = useState(null);
  const [selectedResourceId, setSelectedResourceId] = useState(null);
  const [selectedRealRouteId, setSelectedRealRouteId] = useState(null);
  const [analysis, setAnalysis] = useState({ status: 'idle' });
  const [weather, setWeather] = useState({ status: 'idle', kind: null, data: null });
  const [scenarioRequest, setScenarioRequest] = useState(null);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [evidenceTab, setEvidenceTab] = useState('ml');

  const EVIDENCE_TABS = [
    { id: 'ml', label: 'ML RESULTS' },
    { id: 'trajectories', label: 'TRAJECTORIES' },
    { id: 'validation', label: 'VALIDATION' },
    { id: 'pipeline', label: 'PIPELINE' },
    { id: 'provenance', label: 'PROVENANCE' },
  ];

  const destinationEntered = destination.trim() !== '';
  const analyzed = trip !== null;
  const analysisReady = analysis.status === 'ready';

  const pendingScrollRef = useRef(null);

  // Browser current location (explicit permission, never fabricated).
  useEffect(() => {
    let cancelled = false;
    setLocation({ status: 'loading', coords: null, source: null });
    locationProvider.detect().then((result) => {
      if (!cancelled) setLocation(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const resetSelection = () => {
    setSelectedRouteId(null);
    setSelectedResourceId(null);
    setSelectedRealRouteId(null);
  };

  const scrollToSection = (id) => {
    const el = document.getElementById(id);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return true;
    }
    return false;
  };

  const goToView = (nextView, scrollId) => {
    if (nextView && nextView !== view) {
      viewStackRef.current.push(view);
    }
    setView(nextView);
    pendingScrollRef.current = scrollId || null;
  };

  const goBack = () => {
    const previous = viewStackRef.current.pop();
    setView(previous && previous !== view ? previous : 'home');
    pendingScrollRef.current = null;
  };

  useEffect(() => {
    const id = pendingScrollRef.current;
    pendingScrollRef.current = null;
    requestAnimationFrame(() => {
      if (id) {
        scrollToSection(id);
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }, [view]);

  const handleOriginChange = (value) => {
    setOrigin(value);
    setOriginFromLocation(false);
  };

  const handleUseLocationAsOrigin = () => {
    if (location.status !== 'live' || !location.coords) return;
    setOrigin('My current location');
    setOriginFromLocation(true);
  };

  const handleDestinationChange = (value) => {
    setDestination(value);
    setTrip(null);
    setAnalysis({ status: 'idle' });
    setWeather({ status: 'idle', kind: null, data: null });
    resetSelection();
  };

  const handleAnalyze = async (originValue, destinationValue, opts = {}) => {
    const useCurrentLocation =
      opts.forceCurrentLocation === true
        ? location.status === 'live' && location.coords
        : originFromLocation && location.status === 'live' && location.coords;
    const originCoords = useCurrentLocation
      ? { name: 'My current location', lat: location.coords.lat, lon: location.coords.lon }
      : null;
    goToView('home', 'map');
    setTrip({ origin: originValue.trim(), destination: destinationValue.trim() });
    resetSelection();
    setAnalysis({ status: 'geocoding' });
    setWeather({ status: 'idle', kind: null, data: null });
    try {
      const result = await tripService.analyzeRealRoutes({
        origin: originValue,
        destination: destinationValue,
        originCoords,
      });
      setAnalysis({ status: 'ready', ...result });
      await loadWeatherFor(result.destinationResolved);
    } catch (error) {
      setAnalysis({ status: errorKindFor(error) });
    }
  };

  const loadWeatherFor = async (resolvedDestination) => {
    if (!resolvedDestination) {
      setWeather({ status: 'unavailable', kind: 'invalid-coordinates', data: null });
      return;
    }
    setWeather({ status: 'loading', kind: null, data: null });
    try {
      const data = await weatherService.getCurrentWeather({
        lat: resolvedDestination.lat,
        lon: resolvedDestination.lon,
      });
      setWeather({ status: 'ready', kind: 'ready', data });
    } catch (error) {
      setWeather({ status: 'unavailable', kind: weatherErrorKindFor(error), data: null });
    }
  };

  const handleSelectRoute = (routeId) => {
    setSelectedRouteId(routeId);
    setSelectedResourceId(null);
  };

  const handleSelectRealRoute = (routeId) => {
    setSelectedRealRouteId(routeId);
    setSelectedResourceId(null);
  };

  const handleSelectResource = (resourceId) => setSelectedResourceId(resourceId);
  const handleCloseResource = () => setSelectedResourceId(null);

  // Per-route intelligence snapshot (route reasoning stays out of the UI).
  const tripIntel = useMemo(() => {
    if (!analysisReady || !Array.isArray(analysis.routes) || analysis.routes.length === 0) {
      return null;
    }
    return tripService.enrichRoutes({
      routes: analysis.routes,
      weather: weather.status === 'ready' && weather.data ? weather.data : null,
    });
  }, [analysisReady, analysis, weather.status, weather.data]);

  const handleAssistantAction = (action) => {
    if (!action || !action.type) return;
    switch (action.type) {
      case 'SET_TRIP':
        setOrigin(action.origin || '');
        setDestination(action.destination || '');
        setTrip(null);
        setAnalysis({ status: 'idle' });
        setWeather({ status: 'idle', kind: null, data: null });
        resetSelection();
        if (action.autoAnalyze && action.origin === 'My current location') {
          if (location.status === 'live' && location.coords) {
            setOriginFromLocation(true);
            handleAnalyze('My current location', action.destination || '', {
              forceCurrentLocation: true,
            });
          } else {
            setOriginFromLocation(true);
            goToView('home', 'trip');
          }
        } else {
          setOriginFromLocation(false);
          goToView('home', 'trip');
        }
        break;
      case 'REQUEST_ROUTE_ANALYSIS':
        if (origin.trim() && destination.trim()) {
          handleAnalyze(origin, destination);
        }
        break;
      case 'SHOW_ROUTE':
        goToView('home', 'map');
        break;
      case 'SHOW_WEATHER':
        goToView('intelligence', 'live-weather');
        break;
      case 'OPEN_INVESTIGATION':
        goToView('cctv', 'cctv');
        break;
      case 'OPEN_INTELLIGENCE':
        goToView('intelligence');
        break;
      case 'OPEN_EVIDENCE':
        goToView('evidence');
        break;
      case 'GO_BACK':
        goBack();
        break;
      case 'SELECT_ROUTE': {
        const list = analysisReady && Array.isArray(analysis.routes) ? analysis.routes : [];
        const target =
          typeof action.routeId === 'string'
            ? list.find((r) => r.id === action.routeId) || null
            : typeof action.routeIndex === 'number' && action.routeIndex >= 0
              ? list[action.routeIndex] || null
              : null;
        if (target) {
          handleSelectRealRoute(target.id);
          if (action.openInvestigation) {
            goToView('cctv', 'cctv');
          } else {
            goToView('home', 'map');
          }
        }
        break;
      }
      case 'SIMULATE_SCENARIO':
        setScenarioRequest({ traffic: action.traffic || null, at: Date.now() });
        goToView('intelligence', 'scenario');
        break;
      case 'CLEAR_TRIP':
        setOrigin('');
        setDestination('');
        setTrip(null);
        setAnalysis({ status: 'idle' });
        setWeather({ status: 'idle', kind: null, data: null });
        resetSelection();
        goToView('home', 'trip');
        break;
      default:
        break;
    }
  };

  const selectedRealRoute = useMemo(() => {
    if (!analysisReady || !Array.isArray(analysis.routes) || analysis.routes.length === 0) {
      return null;
    }
    return (
      analysis.routes.find((r) => r.id === selectedRealRouteId) ||
      analysis.routes[0]
    );
  }, [analysisReady, analysis, selectedRealRouteId]);

  const baseInvestigation = useMemo(
    () =>
      tripInvestigationState({
        destinationEntered,
        analysisReady,
        realRouteSelected: selectedRealRoute !== null,
      }),
    [destinationEntered, analysisReady, selectedRealRoute]
  );

  // Investigation sources for the selected real route are the DEMO CCTV
  // cameras associated with its segments (never a generic catalogue and never
  // geographically mapped).
  const investigation = useMemo(() => {
    const routeCameras =
      tripIntel && selectedRealRoute
        ? tripIntel.cctv && tripIntel.cctv.byRoute
          ? tripIntel.cctv.byRoute[selectedRealRoute.id] || []
          : []
        : [];
    if (selectedRealRoute && routeCameras.length > 0) {
      return {
        ...baseInvestigation,
        kind: 'route-selected',
        visible: true,
        message: '',
        resources: routeCameras.map((c) => ({ ...c, geographicallyMapped: false })),
      };
    }
    return baseInvestigation;
  }, [tripIntel, selectedRealRoute, baseInvestigation]);

  // Recorded ML video evidence for the selected real route — the deep-dive
  // panels live in the Evidence view (never presented as mapped live CCTV).
  const recordedVideoSources = useMemo(
    () =>
      investigation && Array.isArray(investigation.resources)
        ? investigation.resources
        : [],
    [investigation]
  );

  const selectedAssessment =
    tripIntel && selectedRealRoute && tripIntel.assessments
      ? tripIntel.assessments[selectedRealRoute.id] || null
      : null;

  const assistantState = useMemo(
    () => {
      const routesData = getRoutes();
      const candidates =
        tripStage({ destinationEntered, analyzed }) === 'routes-ready'
          ? routeCandidates(routesData.rows, { destinationEntered, analyzed })
          : null;
      return {
        origin,
        destination,
        location,
        trip,
        analysisStatus: analysis.status,
        analysis,
        selectedRealRoute,
        weather,
        cctvPolicy: investigation,
        investigationOpen: selectedResourceId !== null,
        recommendation: tripIntel ? tripIntel.recommendation : null,
        traffic: tripIntel && tripIntel.traffic ? tripIntel.traffic : null,
        cctv: tripIntel && tripIntel.cctv ? tripIntel.cctv : null,
        assessments: tripIntel && tripIntel.assessments ? tripIntel.assessments : null,
        realRoutes: tripIntel && tripIntel.routes ? tripIntel.routes : null,
      };
    },
    [
      origin,
      destination,
      location,
      trip,
      analysis,
      selectedRouteId,
      selectedResourceId,
      selectedRealRouteId,
      destinationEntered,
      analyzed,
      analysisReady,
      weather,
      investigation,
      selectedRealRoute,
      tripIntel,
    ]
  );

  const assistantService = useMemo(
    () =>
      createAssistantService({
        getState: () => assistantState,
        emitAction: handleAssistantAction,
      }),
    [assistantState]
  );

  const handleAssistantMessage = (text) => assistantService.handleMessage(text);

  const scenarioRouteCtx = useMemo(
    () => {
      const routesData = getRoutes();
      const candidates =
        tripStage({ destinationEntered, analyzed }) === 'routes-ready'
          ? routeCandidates(routesData.rows, { destinationEntered, analyzed })
          : null;
      const demoRoute =
        selectedRouteId && candidates
          ? candidates.find((r) => r.route_id === selectedRouteId) || null
          : null;
      const realRoute = selectedRealRoute;
      return scenarioUiState({ trip, analysisReady, realRoute, demoRoute });
    },
    [
      trip,
      analysisReady,
      selectedRouteId,
      selectedRealRouteId,
      selectedRealRoute,
      destinationEntered,
      analyzed,
      analysis,
    ]
  );

  return (
    <div className="app">
      <Header currentView={view} onNavigate={(next) => goToView(next, null)} />

      <main className="app-main">
        {view === 'home' ? (
          <div className="view home-view command-center" data-view="home">
            <div className="command-stage">
              <div className="map-frame trip-map-frame command-map">
                <MapView
                  currentLocation={
                    location.status === 'live' && location.coords
                      ? { lat: location.coords.lat, lon: location.coords.lon }
                      : null
                  }
                  origin={analysisReady ? analysis.originResolved : null}
                  destination={analysisReady ? analysis.destinationResolved : null}
                  routes={analysisReady && Array.isArray(analysis.routes) ? analysis.routes : []}
                  selectedRouteId={selectedRealRoute ? selectedRealRoute.id : null}
                  onSelectRoute={handleSelectRealRoute}
                />
              </div>

              <div className="trip-dock">
                <TripPlanningSection
                  docked
                  origin={origin}
                  destination={destination}
                  onOriginChange={handleOriginChange}
                  onDestinationChange={handleDestinationChange}
                  onAnalyze={handleAnalyze}
                  trip={trip}
                  analysisStatus={analysis.status}
                  locationCard={locationCard(location)}
                  originFromLocation={originFromLocation}
                  onUseLocation={handleUseLocationAsOrigin}
                  onOpenVoice={() => setAssistantOpen(true)}
                />
              </div>

              <div className="routes-strip">
                <RealRouteSection
                  analysis={analysis}
                  selectedRealRouteId={selectedRealRouteId}
                  onSelectRealRoute={handleSelectRealRoute}
                  trip={trip}
                  weather={weather}
                  intel={tripIntel}
                />
              </div>

              <div className="map-status-chip" aria-live="polite">
                {location.status === 'live' && location.coords ? (
                  <span className="geo-status">
                    <span className="geo-dot" aria-hidden="true" />
                    You are here
                  </span>
                ) : location.status === 'loading' ? (
                  <span className="geo-status">Locating…</span>
                ) : (
                  <span className="geo-status">Location unavailable</span>
                )}
                {analysisReady && Array.isArray(analysis.routes) && analysis.routes.length > 0 ? (
                  <span className="route-count">
                    <span className="status-dot" aria-hidden="true" /> ROUTE ANALYSIS READY ·{' '}
                    {analysis.routes.length} OSRM alternative{analysis.routes.length === 1 ? '' : 's'}
                  </span>
                ) : null}
                {analysisReady ? (
                  <span className="layer-status" aria-hidden="true">
                    <span className="ls-chip ls-live">Routing LIVE</span>
                    <span className={`ls-chip${weather.status === 'ready' ? ' ls-live' : ' ls-mock'}`}>
                      Weather {weather.status === 'ready' ? 'LIVE' : '—'}
                    </span>
                    <span className="ls-chip ls-mock">Road SIMULATED · DEMO</span>
                    <span className="ls-chip ls-mock">CCTV recorded · demo</span>
                  </span>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

        {view === 'cctv' ? (
          <div className="view cctv-view workspace-view" data-view="cctv">
            <header className="workspace-head">
              <div className="workspace-title">
                <h2>INVESTIGATION</h2>
                <p className="section-sub">
                  {trip && selectedRealRoute
                    ? `${trip.origin || 'Origin'} → ${trip.destination} · ${selectedRealRoute.name} · ${selectedRealRoute.distanceKm} km · ${selectedRealRoute.durationMin} min (live)`
                    : 'Route-centric recorded-demo CCTV operation workspace · RECORDED DEMO sources only.'}
                </p>
              </div>
              <StatusBadge status="RECORDED" note="Recorded demo sources" />
            </header>
            <CctvInvestigationSection
              trip={trip}
              routes={analysisReady && Array.isArray(analysis.routes) ? analysis.routes : null}
              selectedRealRouteId={selectedRealRouteId}
              onSelectRoute={handleSelectRealRoute}
              intel={tripIntel}
            />
          </div>
        ) : null}

        {view === 'intelligence' ? (
          <div className="view intel-view workspace-view" data-view="intelligence">
            <header className="workspace-head">
              <div className="workspace-title">
                <h2>INTELLIGENCE</h2>
                <p className="section-sub">
                  Route-analysis cockpit for the selected route — live weather, traffic/road context and what-if. Live providers stay LIVE; demo and mock layers keep their labels.
                </p>
              </div>
              <StatusBadge status="STATIC" note="Reasoning layer" />
            </header>
            <RouteReasoningPanel
              trip={trip}
              route={selectedRealRoute}
              routes={analysisReady && Array.isArray(analysis.routes) ? analysis.routes : null}
              intel={tripIntel}
              assessment={selectedAssessment}
              weather={weather}
              recommendation={tripIntel ? tripIntel.recommendation : null}
              onSelectRoute={handleSelectRealRoute}
            />
            <div className="intel-lower-grid">
              <div className="intel-lower-col">
                <CurrentWeatherSection
                  weather={weather}
                  coords={analysisReady ? analysis.destinationResolved : null}
                  destinationName={trip ? trip.destination : null}
                />
              </div>
              <div className="intel-lower-col">
                <ScenarioSimulationSection
                  trip={trip}
                  analysisReady={analysisReady}
                  realRoute={scenarioRouteCtx.kind === 'real' ? scenarioRouteCtx.realRoute : null}
                  demoRoute={scenarioRouteCtx.demoRoute}
                  scenarioRequest={scenarioRequest}
                />
              </div>
            </div>
          </div>
        ) : null}

        {view === 'evidence' ? (
          <div className="view evidence-block workspace-view" id="evidence" data-view="evidence">
            <header className="workspace-head">
              <div className="workspace-title">
                <h2>Evidence &amp; Historical Data</h2>
                <p className="section-sub">
                  Validated ML statistics and recorded video evidence, on demand only — never on MAP / HOME.
                </p>
              </div>
              <StatusBadge status="STATIC" note="Processed analysis" />
            </header>

            <div className="evidence-tabs" role="tablist" aria-label="Evidence workspaces">
              {EVIDENCE_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={evidenceTab === tab.id}
                  className={`evidence-tab${evidenceTab === tab.id ? ' evidence-tab-active' : ''}`}
                  onClick={() => setEvidenceTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>

            <div className="evidence-tabpanel" role="tabpanel" hidden={evidenceTab !== 'ml'} data-evidence-panel="ml">
              <OverviewSection />
              <TrafficSection />
            </div>
            <div className="evidence-tabpanel" role="tabpanel" hidden={evidenceTab !== 'trajectories'} data-evidence-panel="trajectories">
              <RecordedVideoEvidenceSection
                trip={trip}
                realRoute={selectedRealRoute}
                sources={recordedVideoSources}
                selectedResourceId={selectedResourceId}
                onSelectResource={handleSelectResource}
                onCloseResource={handleCloseResource}
              />
            </div>
            <div className="evidence-tabpanel" role="tabpanel" hidden={evidenceTab !== 'validation'} data-evidence-panel="validation">
              <div className="two-col">
                <WeatherSection />
                <RoadConditionSection />
              </div>
              <RoadScoreSection />
            </div>
            <div className="evidence-tabpanel" role="tabpanel" hidden={evidenceTab !== 'pipeline'} data-evidence-panel="pipeline">
              <RouteSelectionArea
                destinationEntered={destinationEntered}
                analyzed={analyzed}
                selectedRouteId={selectedRouteId}
                onSelectRoute={handleSelectRoute}
                trip={trip}
                mapReady={analysisReady}
              />
              <SystemPipelineSection
                weatherReady={weather.status === 'ready'}
                routeReady={analysisReady}
              />
            </div>
            <div className="evidence-tabpanel" role="tabpanel" hidden={evidenceTab !== 'provenance'} data-evidence-panel="provenance">
              <ProvenanceLegend />
              <ProvenanceSection />
              <DataFooter />
            </div>
          </div>
        ) : null}
      </main>

      <AIAssistantSection
        onProcess={handleAssistantMessage}
        voiceService={voiceService}
        open={assistantOpen}
        onClose={setAssistantOpen}
      />
    </div>
  );
}