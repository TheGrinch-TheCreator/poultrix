import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";
import { PageSkeleton } from "./components/poultrix/PageSkeleton";

export const getRouter = () => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    // Skeleton appears only if a page is genuinely still loading after 250ms, and stays briefly to avoid flicker.
    defaultPendingComponent: () => <PageSkeleton />,
    defaultPendingMs: 250,
    defaultPendingMinMs: 300,
  });

  return router;
};
