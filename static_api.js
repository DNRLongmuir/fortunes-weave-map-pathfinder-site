(function () {
  'use strict';

  const nativeFetch = window.fetch.bind(window);
  const runtimePromise = nativeFetch('./data/runtime.json?v=80ae8dc').then(response => {
    if (!response.ok) throw new Error('Static planner data could not be loaded.');
    return response.json();
  });

  const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'}
  });
  const errorResponse = (message, status = 422) => jsonResponse({detail: message}, status);
  const key = value => String(value).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const sorted = iterable => [...iterable].sort();
  const pairKey = (left, right) => `${left}\u0000${right}`;

  function compareArrays(left, right) {
    const size = Math.min(left.length, right.length);
    for (let index = 0; index < size; index++) {
      if (left[index] < right[index]) return -1;
      if (left[index] > right[index]) return 1;
    }
    return left.length - right.length;
  }

  function compareCosts(left, right) {
    if (left.turns !== right.turns) return left.turns - right.turns;
    if (left.edges !== right.edges) return left.edges - right.edges;
    return compareArrays(left.shape, right.shape);
  }

  function buildGraph(snapshot, unavailable, discoveredLocationIds = [], allowExploration = true) {
    const blocked = new Set(unavailable || []);
    const nodes = new Map(snapshot.nodes.filter(node => !blocked.has(node.id)).map(node => [node.id, node]));
    const discovered = new Set(discoveredLocationIds || []);
    const undiscovered = new Set([...nodes.values()].filter(node => node.discovered === false && !discovered.has(node.id)).map(node => node.id));
    if (!allowExploration) for (const id of undiscovered) nodes.delete(id);
    const adjacency = new Map([...nodes.keys()].map(id => [id, new Set()]));
    const directed = new Set();
    for (const edge of snapshot.edges) {
      if (!nodes.has(edge.source) || !nodes.has(edge.target)) continue;
      adjacency.get(edge.source).add(edge.target);
      if (edge.directed) directed.add(pairKey(edge.source, edge.target));
      else adjacency.get(edge.target).add(edge.source);
    }
    return {nodes, adjacency, directed, undiscovered};
  }

  function turnOptions(start, graph, carriageLinks, enemies, activeMegaliths, activeTemples) {
    const desertRoads = new Set([...graph.nodes.values()].filter(node => node.region === 'desert' && node.category === 'road').map(node => node.id));
    const interactable = new Set([...graph.nodes.values()].filter(node => ['resource', 'dungeon', 'feast', 'town', 'large_town'].includes(node.category)).map(node => node.id));
    const queue = [{node: start, path: [start]}], bestDepth = new Map([[start, 0]]), walking = [];
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const {node, path} = queue[cursor], depth = path.length - 1;
      if (depth) walking.push({movement_type: 'walk', path, ends_at: node, unused_movement: 3 - depth, turn_cost: 1});
      if ((depth && enemies.has(node)) || depth === 3) continue;
      for (const neighbour of sorted(graph.adjacency.get(node) || [])) {
        if (graph.undiscovered.has(neighbour)) continue;
        if (graph.directed.has(pairKey(node, neighbour))) continue;
        const nextDepth = depth + 1;
        if ((bestDepth.get(neighbour) ?? (nextDepth + 1)) <= nextDepth) continue;
        bestDepth.set(neighbour, nextDepth);
        queue.push({node: neighbour, path: [...path, neighbour]});
      }
    }
    walking.sort((a, b) => b.path.length - a.path.length || a.ends_at.localeCompare(b.ends_at));
    const result = [...walking];
    for (const neighbour of sorted([...(graph.adjacency.get(start) || [])].filter(id => graph.undiscovered.has(id)))) result.push({movement_type: 'walk', path: [start, neighbour], ends_at: neighbour, unused_movement: 0, turn_cost: 1});
    for (const roadNode of sorted(graph.adjacency.get(start) || [])) {
      if (!graph.directed.has(pairKey(start, roadNode))) continue;
      result.push({movement_type: 'walk', path: [start, roadNode], ends_at: roadNode, unused_movement: 0, turn_cost: 1});
      if (!desertRoads.has(roadNode)) continue;
      for (const interaction of sorted(graph.adjacency.get(roadNode) || [])) {
        if (interaction === start || !interactable.has(interaction)) continue;
        result.push({movement_type: 'walk', path: [start, roadNode, interaction], ends_at: interaction, unused_movement: 0, turn_cost: 1});
      }
    }
    for (const approach of walking) {
      for (const destination of sorted(carriageLinks[approach.ends_at] || [])) {
        result.push({movement_type: 'carriage', path: [...approach.path, destination], ends_at: destination, unused_movement: approach.unused_movement, turn_cost: 1});
      }
    }
    for (const destination of sorted(carriageLinks[start] || [])) {
      result.push({movement_type: 'carriage', path: [start, destination], ends_at: destination, unused_movement: 0, turn_cost: 1});
    }
    if (activeMegaliths.has(start)) {
      for (const destination of sorted([...activeMegaliths].filter(id => id !== start))) {
        result.push({movement_type: 'warp', path: [start, destination], ends_at: destination, unused_movement: 0, turn_cost: 0});
      }
    }
    if (activeTemples.has(start) && graph.nodes.has('dagsion')) result.push({movement_type: 'warp', path: [start, 'dagsion'], ends_at: 'dagsion', unused_movement: 0, turn_cost: 1});
    if (start === 'dagsion') for (const destination of sorted(activeTemples)) result.push({movement_type: 'warp', path: [start, destination], ends_at: destination, unused_movement: 0, turn_cost: 1});
    return result;
  }

  function shortestLeg(start, target, graph, carriageLinks, enemies, activeMegaliths, activeTemples) {
    if (start === target) return [];
    const queue = [{node: start, cost: {turns: 0, edges: 0, shape: []}}];
    const parents = new Map([[start, null]]), distances = new Map([[start, {turns: 0, edges: 0, shape: []}]]);
    while (queue.length) {
      queue.sort((a, b) => compareCosts(a.cost, b.cost) || a.node.localeCompare(b.node));
      const current = queue.shift(), known = distances.get(current.node);
      if (compareCosts(current.cost, known) !== 0) continue;
      if (current.node === target) break;
      for (const step of turnOptions(current.node, graph, carriageLinks, enemies, activeMegaliths, activeTemples)) {
        const stepEdges = step.movement_type === 'walk' ? step.path.length - 1 : 0;
        const cost = {
          turns: current.cost.turns + step.turn_cost,
          edges: current.cost.edges + stepEdges,
          shape: step.turn_cost ? [...current.cost.shape, -stepEdges] : current.cost.shape
        };
        const previous = distances.get(step.ends_at);
        if (previous && compareCosts(cost, previous) >= 0) continue;
        distances.set(step.ends_at, cost);
        parents.set(step.ends_at, {node: current.node, step});
        queue.push({node: step.ends_at, cost});
      }
    }
    if (!parents.has(target)) throw new Error(`No route exists from ${start} to ${target} using the currently available movement rules.`);
    const result = [];
    for (let cursor = target; cursor !== start;) {
      const parent = parents.get(cursor);
      result.push(parent.step);
      cursor = parent.node;
    }
    return result.reverse();
  }

  function validateDependencies(request, runtime) {
    if (request.enforce_task_dependencies === false) return;
    const tasks = new Map();
    for (const context of Object.values(runtime.contexts)) {
      for (const task of context.planning_tasks || []) if (task.route_action) tasks.set(task.route_action, task);
    }
    const completed = new Set(request.completed_act3_task_ids || []), seen = new Set();
    for (const stop of request.stopovers || []) {
      const task = tasks.get(stop.action);
      if (!task) continue;
      const missing = (task.prerequisite_task_ids || []).filter(id => !completed.has(id) && !seen.has(id));
      if (task.hard_dependency && missing.length) throw new Error('A required earlier Act III request has not been completed or scheduled first.');
      seen.add(task.id);
    }
  }

  function optimize(request, runtime) {
    const optionalIds = (request.stopovers || []).filter(stop => !stop.required).map(stop => stop.location_id);
    if (new Set(optionalIds).size !== optionalIds.length) throw new Error('An optional stopover may only be listed once.');
    validateDependencies(request, runtime);
    const graph = buildGraph(runtime.map, request.unavailable_location_ids, request.discovered_location_ids, true);
    const requested = new Set([request.start_location_id, request.destination_location_id, ...(request.stopovers || []).map(stop => stop.location_id)]);
    if ([...requested].some(id => !graph.nodes.has(id))) throw new Error('One or more selected locations are unavailable.');
    const repaired = new Set(request.repaired_location_ids || []), carriageLinks = {};
    if (request.allow_carriages !== false) for (const [source, targets] of Object.entries(runtime.carriage_links)) {
      if (repaired.has(source)) carriageLinks[source] = targets.filter(target => repaired.has(target));
    }
    const enemies = new Set((request.enemy_location_ids || []).filter(id => graph.nodes.has(id)));
    const megaliths = request.allow_portals === false ? new Set() : new Set((request.active_megalith_location_ids || []).filter(id => graph.nodes.has(id)));
    const temples = request.allow_portals === false ? new Set() : new Set((request.active_temple_location_ids || []).filter(id => graph.nodes.has(id)));
    const cache = new Map();
    const leg = (start, target) => {
      const cacheKey = `${start}\u0001${target}`;
      if (!cache.has(cacheKey)) cache.set(cacheKey, shortestLeg(start, target, graph, carriageLinks, enemies, megaliths, temples));
      return cache.get(cacheKey);
    };
    const legCost = (start, target) => leg(start, target).reduce((sum, step) => sum + step.turn_cost, 0);
    const requiredStops = (request.stopovers || []).filter(stop => stop.required), optionalStops = (request.stopovers || []).filter(stop => !stop.required);
    let itinerary = [{id: request.start_location_id, stop: null}, ...requiredStops.map(stop => ({id: stop.location_id, stop})), {id: request.destination_location_id, stop: null}];
    if ((request.objective || 'fewest_turns') !== 'fewest_turns') {
      const candidates = [...optionalStops];
      while (candidates.length) {
        let best = null;
        for (const stop of candidates) {
          const ids = itinerary.map(item => item.id), prerequisites = stop.prerequisite_location_ids || [];
          if (prerequisites.some(id => !ids.includes(id))) continue;
          const minimumIndex = prerequisites.reduce((value, id) => Math.max(value, ids.indexOf(id)), 0);
          for (let index = 0; index < itinerary.length - 1; index++) {
            if (index < minimumIndex) continue;
            let direct, detour;
            try {
              direct = legCost(itinerary[index].id, itinerary[index + 1].id);
              detour = legCost(itinerary[index].id, stop.location_id) + legCost(stop.location_id, itinerary[index + 1].id);
            } catch {
              continue;
            }
            if (stop.max_detour_turns != null && detour - direct > stop.max_detour_turns) continue;
            const score = [-Number(stop.priority || 0), detour - direct, stop.location_id, index];
            if (!best || compareArrays(score, best.score) < 0) best = {score, stop, index};
          }
        }
        if (!best) break;
        const proposed = [...itinerary.slice(0, best.index + 1), {id: best.stop.location_id, stop: best.stop}, ...itinerary.slice(best.index + 1)];
        let turns = 0;
        for (let index = 0; index < proposed.length - 1; index++) turns += legCost(proposed[index].id, proposed[index + 1].id);
        turns += proposed.slice(1, -1).reduce((sum, item) => sum + Number(item.stop?.action_cost_turns || 0), 0) + Number(request.destination_action_cost_turns || 0);
        const candidateIndex = candidates.indexOf(best.stop);
        candidates.splice(candidateIndex, 1);
        if (request.available_turns != null && turns > request.available_turns) continue;
        itinerary = proposed;
      }
    }
    const included = itinerary.filter(item => item.stop && !item.stop.required).map(item => item.id), required = new Set(requiredStops.map(stop => stop.location_id)), optional = new Set(included);
    const turns = [], warp_jumps = [];
    for (let index = 0; index < itinerary.length - 1; index++) {
      const target = itinerary[index + 1], steps = leg(itinerary[index].id, target.id);
      steps.forEach((step, stepIndex) => {
        if (step.movement_type === 'warp' && step.turn_cost === 0) { warp_jumps.push({from_location: step.path[0], to_location: step.ends_at}); return; }
        let reason = ['carriage', 'warp'].includes(step.movement_type) ? step.movement_type : 'movement_limit';
        if (stepIndex === steps.length - 1) {
          if (index + 1 === itinerary.length - 1) reason = 'destination';
          else if (required.has(target.id)) reason = 'required_stopover';
          else if (optional.has(target.id)) reason = 'optional_stopover';
        }
        if (enemies.has(step.ends_at)) reason = 'enemy_encounter';
        turns.push({turn: turns.length + 1, movement_type: step.movement_type, path: step.path, ends_at: step.ends_at, end_reason: reason, unused_movement: step.unused_movement, action: stepIndex === steps.length - 1 ? (target.stop?.action || null) : null});
      });
      const actionTurns = index + 1 === itinerary.length - 1 ? Number(request.destination_action_cost_turns || 0) : Number(target.stop?.action_cost_turns || 0);
      const action = index + 1 === itinerary.length - 1 ? (request.destination_action || null) : (target.stop?.action || null);
      for (let count = 0; count < actionTurns; count++) turns.push({turn: turns.length + 1, movement_type: 'action', path: [target.id], ends_at: target.id, end_reason: 'action', unused_movement: 0, action});
    }
    if (request.available_turns != null && turns.length > request.available_turns) throw new Error("Required route exceeds this squad's turn budget.");
    return {status: 'ok', total_turns: turns.length, included_optional_stopovers: included, skipped_optional_stopovers: optionalStops.map(stop => stop.location_id).filter(id => !included.includes(id)), turns, warp_jumps};
  }

  function enemyPaths(request, runtime) {
    const graph = buildGraph(runtime.map, request.unavailable_location_ids, request.discovered_location_ids, false);
    if (![request.target_location_id, ...(request.enemy_location_ids || [])].every(id => graph.nodes.has(id))) throw new Error('One or more enemy-route locations are unavailable.');
    const paths = [];
    for (const start of request.enemy_location_ids || []) {
      const queue = [start], parent = new Map([[start, null]]);
      for (let cursor = 0; cursor < queue.length && !parent.has(request.target_location_id); cursor++) {
        for (const neighbour of sorted(graph.adjacency.get(queue[cursor]) || [])) if (!parent.has(neighbour)) { parent.set(neighbour, queue[cursor]); queue.push(neighbour); }
      }
      if (!parent.has(request.target_location_id)) throw new Error('An enemy has no available route to the defence objective.');
      const path = [];
      for (let cursor = request.target_location_id; cursor != null; cursor = parent.get(cursor)) path.push(cursor);
      path.reverse();
      paths.push({enemy_location_id: start, path, arrival_turn: path.length - 1});
    }
    return {movement_nodes_per_turn: 1, paths};
  }

  function parseInventory(text) {
    const inventory = {}, unmatched = [], pattern = /^\s*(.+?)\s+[—–-]\s+(\d+)\s*$/;
    for (const raw of String(text || '').split(/\r?\n/)) {
      const line = raw.trim(); if (!line) continue;
      const match = line.match(pattern);
      if (!match) { if (/\d/.test(line)) unmatched.push(line); continue; }
      inventory[match[1].trim()] = Number(match[2]);
    }
    return {inventory, unmatched};
  }

  function analyzeInventory(request, runtime) {
    const parsed = parseInventory(request.text), aliases = Object.fromEntries(Object.entries(runtime.inventory.aliases).map(([from, to]) => [key(from), key(to)]));
    const held = {}; for (const [name, quantity] of Object.entries(parsed.inventory)) held[aliases[key(name)] || key(name)] = quantity;
    const sources = {}, shops = {};
    for (const record of runtime.inventory.resources) for (const material of record.materials) (sources[key(material)] ||= new Set()).add(record.stable_id);
    for (const [location, stock] of Object.entries(runtime.inventory.material_shop_stock)) for (const [material, quantity] of Object.entries(stock)) if (quantity > 0) (shops[key(material)] ||= new Set()).add(location);
    const priorities = {temple: 130, posthouse: 110, town: 50}, repaired = new Set(request.repaired_location_ids || []), remaining = {...held}, acquisitions = new Set(), repairs = [];
    const records = [...runtime.inventory.repairs].sort((a, b) => (priorities[b.category] - priorities[a.category]) || a.name.localeCompare(b.name));
    for (const record of records) {
      if (repaired.has(record.location_id)) continue;
      const shortfalls = [];
      for (const [material, required] of Object.entries(record.materials)) {
        const canonical = aliases[key(material)] || key(material), quantity = remaining[canonical] || 0;
        if (quantity < required) {
          const acquisition_location_ids = sorted(sources[canonical] || []), shop_location_ids = sorted(shops[canonical] || []);
          acquisition_location_ids.forEach(id => acquisitions.add(id)); shop_location_ids.forEach(id => acquisitions.add(id));
          shortfalls.push({material, required, held: quantity, missing: required - quantity, acquisition_location_ids, shop_location_ids});
        }
      }
      const affordable = shortfalls.length === 0;
      if (affordable) for (const [material, required] of Object.entries(record.materials)) { const canonical = aliases[key(material)] || key(material); remaining[canonical] = (remaining[canonical] || 0) - required; }
      repairs.push({location_id: record.location_id, label: record.name, category: record.category, affordable, priority: record.priority ?? priorities[record.category], required_materials: record.materials, shortfalls});
    }
    repairs.sort((a, b) => Number(b.affordable) - Number(a.affordable) || b.priority - a.priority || a.shortfalls.length - b.shortfalls.length || a.label.localeCompare(b.label));
    const nodeById = new Map(runtime.map.nodes.map(node => [node.id, node]));
    return {inventory: parsed.inventory, unmatched_lines: parsed.unmatched, repairs, acquisition_location_ids: sorted(acquisitions), shop_check_location_ids: sorted([...repaired].filter(id => ['town', 'large_town'].includes(nodeById.get(id)?.category))), notes: ['Gathering-node contents are confirmed where listed; yields are unknown.', 'Repaired markets are shop-check candidates only because item-by-item shop stock is not yet documented.', 'Repair costs are a manual community-workbook transcription.']};
  }

  async function apiFetch(input, init = {}) {
    const raw = typeof input === 'string' ? input : input.url;
    const url = new URL(raw, location.href);
    if (!url.pathname.includes('/api/')) return nativeFetch(input, init);
    try {
      const runtime = await runtimePromise, body = init.body ? JSON.parse(init.body) : {};
      if (url.pathname.endsWith('/api/map')) return jsonResponse({...runtime.map, exploration_frontier_location_ids: runtime.exploration_frontier_location_ids || []});
      if (url.pathname.includes('/api/act3/context/')) {
        const id = decodeURIComponent(url.pathname.split('/').pop());
        return runtime.contexts[id] ? jsonResponse(runtime.contexts[id]) : errorResponse('The selected Act III section is unavailable.', 404);
      }
      if (url.pathname.endsWith('/api/planner/optimize')) return jsonResponse(optimize(body, runtime));
      if (url.pathname.endsWith('/api/mission/enemy-paths')) return jsonResponse(enemyPaths(body, runtime));
      if (url.pathname.endsWith('/api/act3/inventory/analyze')) return jsonResponse(analyzeInventory(body, runtime));
      if (url.pathname.endsWith('/api/map/discover')) return jsonResponse(runtime.map);
      if (url.pathname.endsWith('/api/planner/log')) { localStorage.setItem('fw-optimizer-latest-log', JSON.stringify({...body, created_at: new Date().toISOString()})); return jsonResponse({status: 'saved', file: 'browser local storage'}); }
      return errorResponse('This operation is not available in the static planner.', 404);
    } catch (error) {
      return errorResponse(error instanceof Error ? error.message : 'Planner operation failed.');
    }
  }

  window.fetch = apiFetch;
  window.FWStatic = {runtimePromise, optimize, enemyPaths, analyzeInventory};
}());
