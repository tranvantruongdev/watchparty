import React, {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useState,
} from "react";
import { Button } from "@mantine/core";
import { serverPath } from "../../utils/utils";
import { MetadataContext } from "../../MetadataContext";
import { IconStarFilled, IconTool } from "@tabler/icons-react";

// Click-gated modal: load on demand (preloaded on pointer-over below) instead
// of riding the eager bundle every route pays for
const loadSubscribeModal = () =>
  import("../Modal/SubscribeModal").then((m) => ({
    default: m.SubscribeModal,
  }));
const SubscribeModal = lazy(loadSubscribeModal);

export const SubscribeButton = () => {
  const { isSubscriber } = useContext(MetadataContext);
  const [isSubscribeModalOpen, setIsSubscribeModalOpen] = useState(false);
  if (isSubscriber === undefined || isSubscriber) {
    return null;
  }
  return (
    <>
      {isSubscribeModalOpen && (
        <Suspense fallback={null}>
          <SubscribeModal
            closeSubscribe={() => setIsSubscribeModalOpen(false)}
          />
        </Suspense>
      )}
      <Button
        leftSection={<IconStarFilled />}
        color="orange"
        onPointerEnter={() => loadSubscribeModal()}
        onFocus={() => loadSubscribeModal()}
        onClick={() => setIsSubscribeModalOpen(true)}
      >
        Subscribe
      </Button>
    </>
  );
};

export const ManageSubButton = ({}: {}) => {
  const { user } = useContext(MetadataContext);
  const onManage = useCallback(async () => {
    const resp = await fetch(serverPath + "/manageSub", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        uid: user?.uid,
        token: await user?.getIdToken(),
        return_url: window.location.href,
      }),
    });
    const session = await resp.json();
    console.log(session);
    window.location.assign(session.url);
  }, [user]);
  return (
    <Button leftSection={<IconTool />} color="orange" onClick={onManage}>
      Manage Subscription
    </Button>
  );
};
