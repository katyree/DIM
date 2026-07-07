import { D2ManifestDefinitions } from 'app/destiny2/d2-definitions';
import { t } from 'app/i18next-t';
import { canInsertPlug, insertPlug } from 'app/inventory/advanced-write-actions';
import { DimItem, DimSocket } from 'app/inventory/item-types';
import { DEFAULT_ORNAMENTS } from 'app/search/d2-known-values';
import { ThunkResult } from 'app/store/types';
import { CancelToken } from 'app/utils/cancel';
import { count, uniqBy } from 'app/utils/collections';
import { errorMessage } from 'app/utils/errors';
import { plugFitsIntoSocket } from 'app/utils/socket-utils';
import { Destiny2CoreSettings } from 'bungie-api-ts/core';
import { ItemCategoryHashes, PlugCategoryHashes } from 'data/d2/generated-enums';
import { d2ManifestSelector, destiny2CoreSettingsSelector } from '../manifest/selectors';

export interface SetSocketAction {
  item: DimItem;
  socketIndex: number;
}

export interface SetSocketKindGroup {
  groupKey: string;
  kind: SocketKind;
  items: SetSocketAction[];
  representativeItem: DimItem;
  representativeSocket: DimSocket;
  representativePlug: NonNullable<DimSocket['plugged']>['plugDef'];
  numWeapons: number;
  numArmor: number;
  numOthers: number;
  numApplicableSockets: number;
}

function socketCanAcceptShader(socket: DimSocket, defs: D2ManifestDefinitions) {
  return defs.SocketType.get(socket.socketDefinition.socketTypeHash)?.plugWhitelist.some(
    (plug) => plug.categoryHash === PlugCategoryHashes.Shader,
  );
}

function identifySocket(socket: DimSocket, defs: D2ManifestDefinitions) {
  const plugDef = socket.plugged?.plugDef;

  if (
    plugDef?.itemCategoryHashes?.includes(ItemCategoryHashes.Shaders) &&
    !DEFAULT_ORNAMENTS.includes(plugDef.hash) &&
    socketCanAcceptShader(socket, defs)
  ) {
    return 'shaders';
  }
}

export type SocketKind = NonNullable<ReturnType<typeof identifySocket>>;

export function collectSocketsToSet(
  filteredItems: DimItem[],
  destiny2CoreSettings: Destiny2CoreSettings | undefined,
  defs: D2ManifestDefinitions,
) {
  const socketsByKind: {
    [groupKey: string]: {
      kind: SocketKind;
      entries: { item: DimItem; socket: DimSocket }[];
    };
  } = {};

  for (const item of filteredItems) {
    if (!item.instanced) {
      continue;
    }

    for (const socket of item.sockets?.allSockets ?? []) {
      const kind = identifySocket(socket, defs);
      const groupKey = kind;
      if (
        kind &&
        groupKey &&
        socket.plugged &&
        canInsertPlug(socket, socket.plugged.plugDef.hash, destiny2CoreSettings, defs)
      ) {
        (socketsByKind[groupKey] ??= { kind, entries: [] }).entries.push({ item, socket });
      }
    }
  }

  const socketKinds: SetSocketKindGroup[] = [];
  for (const groupKey in socketsByKind) {
    const { kind, entries } = socketsByKind[groupKey];
    const affectedItems = uniqBy(entries, (entry) => entry.item.id);
    const numApplicableItems = affectedItems.length;

    const numWeapons = count(affectedItems, (entry) => entry.item.bucket.inWeapons);
    const numArmor = count(affectedItems, (entry) => entry.item.bucket.inArmor);
    const numOthers = numApplicableItems - numWeapons - numArmor;

    const representative = entries.at(-1)!;

    socketKinds.push({
      groupKey,
      kind,
      items: entries.map(({ item, socket }) => ({ item, socketIndex: socket.socketIndex })),
      representativeItem: representative.item,
      representativeSocket: representative.socket,
      representativePlug: representative.socket.plugged!.plugDef,
      numWeapons,
      numArmor,
      numOthers,
      numApplicableSockets: entries.length,
    });
  }

  return socketKinds;
}

export function doSetSockets(
  socketList: SetSocketAction[],
  plugHash: number,
  cancelToken: CancelToken,
  progressCallback: (idx: number, errorMsg: string | undefined) => void,
): ThunkResult {
  return async (dispatch, getState) => {
    const defs = d2ManifestSelector(getState())!;
    const destiny2CoreSettings = destiny2CoreSettingsSelector(getState());

    for (let i = 0; i < socketList.length; i++) {
      cancelToken.checkCanceled();

      const entry = socketList[i];

      try {
        const socket = entry.item.sockets?.allSockets.find(
          (s) => s.socketIndex === entry.socketIndex,
        );
        if (
          !socket ||
          !plugFitsIntoSocket(socket, plugHash) ||
          !canInsertPlug(socket, plugHash, destiny2CoreSettings, defs)
        ) {
          progressCallback(i, t('AWA.NotSupported'));
          continue;
        }

        if (socket.plugged?.plugDef.hash === plugHash) {
          progressCallback(i, undefined);
          continue;
        }

        await dispatch(insertPlug(entry.item, socket, plugHash));
        progressCallback(i, undefined);
      } catch (e) {
        progressCallback(i, errorMessage(e));
      }
    }
  };
}
