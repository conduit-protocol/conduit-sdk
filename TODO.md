# TODO: Fix Token Selector Client-Side Validation Bypass

## Steps

- [x] Step 0: Analyze codebase and understand the validation gaps
- [x] Step 1: Enhance `StreamBuilder._validateAddress()` to use `StrKey` validation for token (C-addresses) and sender/recipient (G-addresses)
- [ ] Step 2: Enhance `validatePayload()` to perform field-level address validation (token, sender, recipient)
- [ ] Step 3: Apply consistent validation in `ConduitBatcher.executeAsync()` 
- [ ] Step 4: Update test coverage in `builder-validation-bypass.test.ts`
- [ ] Step 5: Run tests to verify all existing tests still pass

