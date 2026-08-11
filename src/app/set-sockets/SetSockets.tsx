import { PressTip } from 'app/dim-ui/PressTip';
import Sheet from 'app/dim-ui/Sheet';
import { I18nKey, t, tl } from 'app/i18next-t';
import { DefItemIcon } from 'app/inventory/ItemIcon';
import { canInsertPlug } from 'app/inventory/advanced-write-actions';
import { PluggableInventoryItemDefinition } from 'app/inventory/item-types';
import { locateItem } from 'app/inventory/locate-item';
import { allItemsSelector } from 'app/inventory/selectors';
import SocketDetails from 'app/item-popup/SocketDetails';
import { destiny2CoreSettingsSelector, useD2Definitions } from 'app/manifest/selectors';
import { filterFactorySelector } from 'app/search/items/item-search-filter';
import { AppIcon, refreshIcon } from 'app/shell/icons';
import { useThunkDispatch } from 'app/store/thunk-dispatch';
import { withCancel } from 'app/utils/cancel';
import clsx from 'clsx';
import { ItemCategoryHashes } from 'data/d2/generated-enums';
import chestArmorItem from 'destiny-icons/armor_types/chest.svg';
import ghostIcon from 'destiny-icons/general/ghost.svg';
import handCannonIcon from 'destiny-icons/weapons/hand_cannon.svg';
import { produce } from 'immer';
import React, { useCallback, useEffect, useMemo, useReducer, useState } from 'react';
import { useSelector } from 'react-redux';
import { useSubscription } from 'use-subscription';
import { showNotification } from '../notifications/notifications';
import * as styles from '../strip-sockets/StripSockets.m.scss';
import { plugFitsIntoSocket } from '../utils/socket-utils';
import {
  collectSocketsToSet,
  doSetSockets,
  SetSocketAction,
  SetSocketKindGroup,
} from './set-sockets';
import { setSocketsQuery$ } from './set-sockets-actions';

const i18nKeys: NodeJS.Dict<I18nKey> = {
  shaders: tl('SetSockets.Shaders'),
};

type SocketState = string | 'ok' | 'todo';

type State =
  | {
      tag: 'selecting';
    }
  | {
      tag: 'processing';
      cancel: () => void;
      cancelling: boolean;
      socketList: SetSocketAction[];
      socketStates: SocketState[];
      plugItemDef: PluggableInventoryItemDefinition;
    }
  | {
      tag: 'done';
      socketList: SetSocketAction[];
      socketStates: SocketState[];
      plugItemDef: PluggableInventoryItemDefinition;
    };

type UIAction =
  | {
      tag: 'cancel_process';
    }
  | {
      tag: 'confirm_process';
      socketList: SetSocketAction[];
      cancel: () => void;
      plugItemDef: PluggableInventoryItemDefinition;
    }
  | {
      tag: 'confirm_results';
    }
  | {
      tag: 'notify_done';
      success: boolean;
    }
  | {
      tag: 'notify_progress';
      idx: number;
      error: string | undefined;
    };

function reducer(state: State, action: UIAction): State {
  switch (action.tag) {
    case 'cancel_process':
      if (state.tag === 'processing') {
        state.cancel();

        return produce(state, (draft) => {
          draft.tag === 'processing' && (draft.cancelling = true);
        });
      } else if (state.tag === 'done') {
        return { tag: 'selecting' };
      }
      break;
    case 'confirm_process':
      if (state.tag === 'selecting') {
        return {
          tag: 'processing',
          cancel: action.cancel,
          cancelling: false,
          socketList: action.socketList,
          socketStates: Array<string>(action.socketList.length).fill('todo'),
          plugItemDef: action.plugItemDef,
        };
      }
      break;
    case 'confirm_results':
      if (state.tag === 'done') {
        return { tag: 'selecting' };
      }
      break;
    case 'notify_done':
      if (state.tag === 'processing') {
        if (action.success) {
          return {
            tag: 'done',
            socketList: state.socketList,
            socketStates: state.socketStates,
            plugItemDef: state.plugItemDef,
          };
        } else {
          return { tag: 'selecting' };
        }
      }
      break;
    case 'notify_progress':
      if (state.tag === 'processing') {
        return produce(state, (draft) => {
          draft.tag === 'processing' && (draft.socketStates[action.idx] = action.error ?? 'ok');
        });
      }
      break;
  }
  return state;
}

export default function SetSockets() {
  const dispatch = useThunkDispatch();
  const defs = useD2Definitions()!;
  const destiny2CoreSettings = useSelector(destiny2CoreSettingsSelector);
  const [state, setDispatch] = useReducer(reducer, { tag: 'selecting' });
  const [socketKindInMenu, setSocketKindInMenu] = useState<SetSocketKindGroup>();
  const query = useSubscription(setSocketsQuery$);

  const isChoosing = state.tag === 'selecting';

  const onCancel = () => {
    setDispatch({ tag: 'cancel_process' });
  };

  const onConfirmSockets = useCallback(
    async (socketList: SetSocketAction[], plugItemDef: PluggableInventoryItemDefinition) => {
      if (!isChoosing) {
        return;
      }

      const compatibleSockets = socketList.filter(({ item, socketIndex }) => {
        const socket = item.sockets?.allSockets.find((s) => s.socketIndex === socketIndex);
        return (
          socket &&
          plugFitsIntoSocket(socket, plugItemDef.hash) &&
          canInsertPlug(socket, plugItemDef.hash, destiny2CoreSettings, defs) &&
          socket.plugged?.plugDef.hash !== plugItemDef.hash
        );
      });

      if (compatibleSockets.length === 0) {
        showNotification({
          type: 'warning',
          title: t('SetSockets.NoCompatibleTitle'),
          body: t('SetSockets.NoCompatibleBody'),
        });
        return;
      }

      const [cancelToken, cancel] = withCancel();

      setDispatch({
        tag: 'confirm_process',
        socketList: compatibleSockets,
        cancel,
        plugItemDef,
      });

      try {
        await dispatch(
          doSetSockets(compatibleSockets, plugItemDef.hash, cancelToken, (idx, error) =>
            setDispatch({ tag: 'notify_progress', idx, error }),
          ),
        );
        setDispatch({ tag: 'notify_done', success: true });
      } catch {
        setDispatch({ tag: 'notify_done', success: false });
      }
    },
    [defs, destiny2CoreSettings, dispatch, isChoosing],
  );

  if (!query) {
    return null;
  }

  const header = (
    <div>
      <h1>
        {isChoosing ? (
          t('SetSockets.Choose')
        ) : state.tag === 'processing' ? (
          <>
            <span>
              <AppIcon icon={refreshIcon} spinning={true} ariaHidden />
            </span>{' '}
            {t('SetSockets.Running')}
          </>
        ) : (
          t('SetSockets.Done')
        )}
      </h1>
    </div>
  );

  let contents, footer;
  if (state.tag === 'selecting') {
    contents = (
      <SetSocketsChoose
        query={query}
        selectedGroupKey={socketKindInMenu?.groupKey}
        onSelectKind={setSocketKindInMenu}
      />
    );
  } else {
    contents = (
      <SetSocketsProcess
        socketList={state.socketList}
        socketStates={state.socketStates}
        plugItemDef={state.plugItemDef}
      />
    );
    if (state.tag === 'processing') {
      footer = (
        <button
          type="button"
          className={styles.insertButton}
          onClick={onCancel}
          disabled={state.cancelling}
        >
          <span>{t('SetSockets.Cancel')}</span>
        </button>
      );
    } else {
      footer = (
        <button
          type="button"
          className={styles.insertButton}
          onClick={() => setDispatch({ tag: 'confirm_results' })}
        >
          <span>{t('SetSockets.Ok')}</span>
        </button>
      );
    }
  }

  return (
    <>
      <Sheet
        onClose={() => {
          onCancel();
          setSocketsQuery$.next(undefined);
          setSocketKindInMenu(undefined);
        }}
        header={header}
        footer={footer}
        sheetClassName={styles.stripSheet}
      >
        {contents}
      </Sheet>
      {socketKindInMenu && (
        <SocketDetails
          item={socketKindInMenu.representativeItem}
          socket={socketKindInMenu.representativeSocket}
          allowInsertPlug={false}
          actionLabel={t('SetSockets.Apply')}
          title={socketKindInMenu.kind === 'shaders' ? t('SetSockets.Action') : undefined}
          plugItemCategoryHashWhitelist={
            socketKindInMenu.kind === 'shaders' ? [ItemCategoryHashes.Shaders] : undefined
          }
          onClose={() => setSocketKindInMenu(undefined)}
          onPlugSelected={({ plugHash }) => {
            const plugItemDef = defs.InventoryItem.get(
              plugHash,
            ) as PluggableInventoryItemDefinition;
            setSocketKindInMenu(undefined);
            void onConfirmSockets(socketKindInMenu.items, plugItemDef);
          }}
        />
      )}
    </>
  );
}

function SetSocketsProcess({
  socketList,
  socketStates,
  plugItemDef,
}: {
  socketList: SetSocketAction[];
  socketStates: SocketState[];
  plugItemDef: PluggableInventoryItemDefinition;
}) {
  return (
    <div className={styles.iconList}>
      {socketList.map((socket, idx) => {
        const state = socketStates[idx];
        const icon = (
          <div onClick={() => locateItem(socket.item)}>
            <DefItemIcon itemDef={plugItemDef} />
          </div>
        );
        const failed = state !== 'ok' && state !== 'todo';
        const key = `${socket.item.index}-${socket.socketIndex}`;
        const className = clsx('item', styles.plug, {
          [styles.ok]: state === 'ok',
          [styles.failed]: failed,
        });
        return failed ? (
          <PressTip minimal key={key} className={className} tooltip={state}>
            {icon}
          </PressTip>
        ) : (
          <div key={key} className={className}>
            {icon}
          </div>
        );
      })}
    </div>
  );
}

function SetSocketsChoose({
  query,
  selectedGroupKey,
  onSelectKind,
}: {
  query: string;
  selectedGroupKey: string | undefined;
  onSelectKind: (kind: SetSocketKindGroup | undefined) => void;
}) {
  const defs = useD2Definitions()!;
  const destiny2CoreSettings = useSelector(destiny2CoreSettingsSelector);
  const allItems = useSelector(allItemsSelector);
  const filterFactory = useSelector(filterFactorySelector);

  const socketKinds = useMemo(() => {
    if (!query) {
      return null;
    }

    const filterFunc = filterFactory(query);
    const filteredItems = allItems.filter((item) => item.sockets && filterFunc(item));
    return collectSocketsToSet(filteredItems, destiny2CoreSettings, defs);
  }, [allItems, defs, destiny2CoreSettings, filterFactory, query]);

  useEffect(() => {
    onSelectKind(undefined);
  }, [onSelectKind, query]);

  return (
    socketKinds && (
      <>
        {socketKinds.length ? (
          socketKinds.map(
            ({
              groupKey,
              kind,
              representativePlug,
              numWeapons,
              numArmor,
              numOthers,
              numApplicableSockets,
            }) => {
              const selected = selectedGroupKey === groupKey;
              const itemCats = [
                { icon: handCannonIcon, num: numWeapons },
                { icon: chestArmorItem, num: numArmor },
                { icon: ghostIcon, num: numOthers },
              ];
              const labelKey = i18nKeys[kind];
              const label =
                (labelKey && t(labelKey, { count: numApplicableSockets })) ||
                `${numApplicableSockets}x ${representativePlug.itemTypeDisplayName}`;

              return (
                <div
                  key={groupKey}
                  className={clsx(styles.socketKindButton, {
                    [styles.selectedButton]: selected,
                  })}
                  onClick={() =>
                    onSelectKind(socketKinds.find((socketKind) => socketKind.groupKey === groupKey))
                  }
                  role="button"
                  tabIndex={0}
                >
                  <div className="item" title={label}>
                    <DefItemIcon itemDef={representativePlug} />
                  </div>
                  <div className={styles.buttonInfo}>
                    <div
                      className={clsx(styles.buttonTitle, {
                        [styles.selectedTitle]: selected,
                      })}
                    >
                      {label}
                    </div>
                  </div>
                  <div>
                    {itemCats.map(
                      ({ icon, num }, idx) =>
                        num > 0 && (
                          <React.Fragment key={idx}>
                            <img src={icon} className={styles.itemTypeIcon} /> {num}
                            <br />
                          </React.Fragment>
                        ),
                    )}
                  </div>
                </div>
              );
            },
          )
        ) : (
          <div className={styles.noSocketsMessage}>{t('SetSockets.NoSockets')}</div>
        )}
      </>
    )
  );
}
