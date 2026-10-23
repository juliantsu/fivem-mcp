--[[
    Value marshalling shared by the client payload (fivem_run_code results) and
    the server eval handler (fivem_server_run_code results).

    Listed under shared_scripts: it contains no secrets and no tooling, only the
    walk that turns whatever a snippet returned into something a JSON encoder
    can carry. Both sides must agree on these caps, which is why the code lives
    in one file instead of two copies that drift.
]]

AgentMarshal = {}

--- Depth and size caps for the value walk. A returned entity table or a
--- resource's export table is easily deep and self-referential; without these
--- the serialiser would be handed something it cannot encode.
AgentMarshal.MAX_DEPTH = 5
AgentMarshal.MAX_KEYS = 60
AgentMarshal.MAX_STRING = 2000

--- Turns whatever a snippet returned into plain data. Anything that is not
--- plain data is replaced by a description of itself, so an unserialisable
--- return value never costs the caller the whole answer.
function AgentMarshal.sanitize(value, depth, seen)
    local kind = type(value)

    if kind == 'number' or kind == 'boolean' then
        return value
    end
    if kind == 'string' then
        if #value > AgentMarshal.MAX_STRING then
            return value:sub(1, AgentMarshal.MAX_STRING)
                .. ('… (%d bytes truncated)'):format(#value - AgentMarshal.MAX_STRING)
        end
        return value
    end
    if kind ~= 'table' then
        -- vector3, functions, userdata, threads: tostring is all there is.
        return ('<%s: %s>'):format(kind, tostring(value))
    end

    if depth <= 0 then
        return '<table: deeper than ' .. AgentMarshal.MAX_DEPTH .. ' levels>'
    end
    -- A true visited set, never un-marked: it catches cycles AND keeps a table
    -- that is reachable along many paths from being walked once per path --
    -- with these caps a diamond-shaped export table was worth up to 60^5 visits.
    if seen[value] then
        return '<table: repeated reference>'
    end
    seen[value] = true

    -- msgpack -> JSON in nui-resources.dll throws (and takes the whole client
    -- down) on a map whose keys are not all strings, e.g. a truncated array with
    -- a '…' key added. So: a real array stays an array, everything else gets
    -- string keys only.
    local n = #value
    local isArray = n > 0
    if isArray then
        for k in pairs(value) do
            if type(k) ~= 'number' or k < 1 or k > n or k % 1 ~= 0 then
                isArray = false
                break
            end
        end
    end

    local out = {}
    if isArray then
        for i = 1, math.min(n, AgentMarshal.MAX_KEYS) do
            local v = value[i]
            out[i] = v == nil and '<nil>' or AgentMarshal.sanitize(v, depth - 1, seen)
        end
        if n > AgentMarshal.MAX_KEYS then
            out[#out + 1] = ('… %d more entries omitted'):format(n - AgentMarshal.MAX_KEYS)
        end
        return out
    end

    local keys = 0
    for k, v in pairs(value) do
        keys = keys + 1
        if keys > AgentMarshal.MAX_KEYS then
            out['…'] = ('more than %d entries, the rest was omitted'):format(AgentMarshal.MAX_KEYS)
            break
        end
        out[tostring(k)] = AgentMarshal.sanitize(v, depth - 1, seen)
    end

    return out
end
