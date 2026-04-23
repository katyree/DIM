import { D2ManifestDefinitions } from 'app/destiny2/d2-definitions';
import { t } from 'app/i18next-t';
import { canInsertPlug, insertPlug } from 'app/inventory/advanced-write-actions';
import { DimItem, DimSocket } from 'app/inventory/item-types';
import { isReducedModCostVariant } from 'app/loadout/mod-utils';
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

function identifySocket(socket: DimSocket) {
  const plugDef = socket.plugged?.plugDef;
  if (!plugDef) {
    return;
  }

  if (plugDef.itemCategoryHashes?.includes(ItemCategoryHashes.Shaders)) {
    return 'shaders';
  } else if (DEFAULT_ORNAMENTS.includes(socket.emptyPlugItemHash!)) {
    return 'ornaments';
  } else if (plugDef.itemCategoryHashes?.includes(ItemCategoryHashes.WeaponModsDamage)) {
    return 'weaponmods';
  } else if (plugDef.itemCategoryHashes?.includes(ItemCategoryHashes.ArmorMods)) {
    if (isReducedModCostVariant(plugDef.hash)) {
      return 'discountedmods';
    }
    return 'armormods';
  } else if (
    plugDef.plug.plugCategoryHash === PlugCategoryHashes.WeaponTieringKillVfx ||
    plugDef.plug.plugCategoryHash === PlugCategoryHashes.V900weaponModConfetti
  ) {
    return 'combatflair';
  } else if (plugDef.plug.plugCategoryHash === PlugCategoryHashes.Hologram) {
    return 'others';
  }
}

export type SocketKind = NonNullable<ReturnType<typeof identifySocket>>;

function getSocketCompatibilitySignature(socket: DimSocket, defs: D2ManifestDefinitions) {
  const plugHashes = new Set<number>();

  if (socket.emptyPlugItemHash) {
    plugHashes.add(socket.emptyPlugItemHash);
  }

  for (const plugItem of socket.reusablePlugItems ?? []) {
    plugHashes.add(plugItem.plugItemHash);
  }

  for (const dimPlug of socket.plugSet?.plugs ?? []) {
    plugHashes.add(dimPlug.plugDef.hash);
  }

  const randomizedPlugSetHash = socket.socketDefinition.randomizedPlugSetHash;
  if (randomizedPlugSetHash) {
    for (const plugItem of defs.PlugSet.get(randomizedPlugSetHash)?.reusablePlugItems ?? []) {
      plugHashes.add(plugItem.plugItemHash);
    }
  }

  const reusablePlugSetHash = socket.socketDefinition.reusablePlugSetHash;
  if (reusablePlugSetHash) {
    for (const plugItem of defs.PlugSet.get(reusablePlugSetHash)?.reusablePlugItems ?? []) {
      plugHashes.add(plugItem.plugItemHash);
    }
  }

  return Array.from(plugHashes)
    .sort((a, b) => a - b)
    .join(',');
}

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
      const kind = identifySocket(socket);
      const compatibilitySignature = kind && getSocketCompatibilitySignature(socket, defs);
      if (
        kind &&
        compatibilitySignature &&
        socket.plugged &&
        canInsertPlug(socket, socket.plugged.plugDef.hash, destiny2CoreSettings, defs)
      ) {
        const groupKey = `${kind}:${compatibilitySignature}`;
        (socketsByKind[groupKey] ??= { kind, entries: [] }).entries.push({ item, socket });
      }
    }
  }

  const socketKinds: SetSocketKindGroup[] = [];
  for (const groupKey in socketsByKind) {
    const { kind, entries } = socketsByKind[groupKey]!;
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
