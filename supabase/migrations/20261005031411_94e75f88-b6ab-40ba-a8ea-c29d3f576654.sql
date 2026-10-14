CREATE POLICY "Users can view their own profile pictures"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'profile-pictures' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can upload their own profile pictures"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'profile-pictures' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can update their own profile pictures"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'profile-pictures' AND (storage.foldername(name))[1] = auth.uid()::text)
WITH CHECK (bucket_id = 'profile-pictures' AND (storage.foldername(name))[1] = auth.uid()::text);

CREATE POLICY "Users can delete their own profile pictures"
ON storage.objects FOR DELETE TO authenticated
USING (bucket_id = 'profile-pictures' AND (storage.foldername(name))[1] = auth.uid()::text);